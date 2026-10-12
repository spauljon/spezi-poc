import oracledb, { type Connection } from "oracledb";
import type { Rollup, Store, StoredRollup, Window } from "./store.ts";

export interface OracleConfig {
  readonly user: string;
  readonly password: string;
  /** For example `127.0.0.1:1522/ANALYTICSPDB`. */
  readonly connectString: string;
}

/**
 * The analytic store in Oracle, as the application user (DML only; the tables belong to the no-login owner and are
 * reached through synonyms). Each public method is one transaction.
 */
export class OracleStore implements Store {
  private constructor(private readonly connection: Connection) {}

  static async connect(config: OracleConfig): Promise<OracleStore> {
    const connection = await oracledb.getConnection({
      user: config.user,
      password: config.password,
      connectString: config.connectString,
    });
    return new OracleStore(connection);
  }

  async close(): Promise<void> {
    await this.connection.close();
  }

  async getWatermark(worker: string): Promise<number | null> {
    const result = await this.connection.execute<{ MS: number }>(
      "select last_updated_ms as ms from rollup_watermark where worker_name = :w",
      { w: worker },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    const row = result.rows?.[0];
    return row ? Number(row.MS) : null;
  }

  async recordTouched(worker: string, windows: readonly Window[], watermarkMs: number | null): Promise<void> {
    try {
      for (const w of windows) {
        await this.connection.execute(
          `merge into rollup_touched t
             using (select :p as patient_id, :m as metric_id, to_date(:d, 'YYYY-MM-DD') as day from dual) s
             on (t.patient_id = s.patient_id and t.metric_id = s.metric_id and t.day = s.day)
             when not matched then insert (patient_id, metric_id, day) values (s.patient_id, s.metric_id, s.day)`,
          { p: w.patientId, m: w.metricId, d: w.day },
        );
      }
      if (watermarkMs !== null) {
        await this.connection.execute(
          `merge into rollup_watermark t
             using (select :w as worker_name, :ms as last_updated_ms from dual) s
             on (t.worker_name = s.worker_name)
             when matched then update set t.last_updated_ms = s.last_updated_ms, t.updated_at = systimestamp
               where s.last_updated_ms > t.last_updated_ms
             when not matched then insert (worker_name, last_updated_ms) values (s.worker_name, s.last_updated_ms)`,
          { w: worker, ms: watermarkMs },
        );
      }
      await this.connection.commit();
    } catch (error) {
      await this.connection.rollback();
      throw error;
    }
  }

  async pendingWindows(limit: number): Promise<Window[]> {
    const result = await this.connection.execute<{ P: string; M: string; D: string }>(
      `select patient_id as p, metric_id as m, to_char(day, 'YYYY-MM-DD') as d
         from rollup_touched order by touched_at, patient_id, metric_id, day fetch first :n rows only`,
      { n: limit },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    return (result.rows ?? []).map((r) => ({ patientId: r.P, metricId: r.M, day: r.D }));
  }

  async applyRollup(window: Window, rollup: Rollup | null): Promise<boolean> {
    const key = { p: window.patientId, m: window.metricId, d: window.day };
    try {
      let changed: boolean;
      if (rollup === null) {
        const deleted = await this.connection.execute(
          "delete from daily_rollup where patient_id = :p and metric_id = :m and day = to_date(:d, 'YYYY-MM-DD')",
          key,
        );
        changed = (deleted.rowsAffected ?? 0) > 0;
      } else {
        // Update only when a value differs, so a recompute with identical data leaves the row (and its revision)
        // untouched; insert when absent.
        const updated = await this.connection.execute(
          `update daily_rollup
              set unit = :u, n = :n, min_value = :lo, median_value = :md, max_value = :hi,
                  revision = revision + 1, updated_at = systimestamp
            where patient_id = :p and metric_id = :m and day = to_date(:d, 'YYYY-MM-DD')
              and (unit <> :u or n <> :n or min_value <> :lo or median_value <> :md or max_value <> :hi)`,
          { ...key, u: rollup.unit, n: rollup.n, lo: rollup.min, md: rollup.median, hi: rollup.max },
        );
        changed = (updated.rowsAffected ?? 0) > 0;
        if (!changed) {
          const inserted = await this.connection.execute(
            `insert into daily_rollup (patient_id, metric_id, day, unit, n, min_value, median_value, max_value)
             select :p, :m, to_date(:d, 'YYYY-MM-DD'), :u, :n, :lo, :md, :hi from dual
              where not exists (select 1 from daily_rollup
                                 where patient_id = :p and metric_id = :m and day = to_date(:d, 'YYYY-MM-DD'))`,
            { ...key, u: rollup.unit, n: rollup.n, lo: rollup.min, md: rollup.median, hi: rollup.max },
          );
          changed = (inserted.rowsAffected ?? 0) > 0;
        }
      }
      await this.connection.execute(
        "delete from rollup_touched where patient_id = :p and metric_id = :m and day = to_date(:d, 'YYYY-MM-DD')",
        key,
      );
      await this.connection.commit();
      return changed;
    } catch (error) {
      await this.connection.rollback();
      throw error;
    }
  }

  async rollups(patientId?: string): Promise<StoredRollup[]> {
    const result = await this.connection.execute<{
      P: string; M: string; D: string; U: string; N: number; LO: number; MD: number; HI: number; R: number;
    }>(
      `select patient_id as p, metric_id as m, to_char(day, 'YYYY-MM-DD') as d, unit as u, n,
              min_value as lo, median_value as md, max_value as hi, revision as r
         from daily_rollup
        where (:p is null or patient_id = :p)
        order by patient_id, metric_id, day`,
      { p: patientId ?? null },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    return (result.rows ?? []).map((r) => ({
      patientId: r.P, metricId: r.M, day: r.D, unit: r.U,
      n: Number(r.N), min: Number(r.LO), median: Number(r.MD), max: Number(r.HI), revision: Number(r.R),
    }));
  }

  /** Test support: remove one worker's watermark and the given windows' rows. */
  async purge(worker: string, windows: readonly Window[]): Promise<void> {
    await this.connection.execute("delete from rollup_watermark where worker_name = :w", { w: worker });
    for (const w of windows) {
      const key = { p: w.patientId, m: w.metricId, d: w.day };
      await this.connection.execute(
        "delete from daily_rollup where patient_id = :p and metric_id = :m and day = to_date(:d, 'YYYY-MM-DD')", key);
      await this.connection.execute(
        "delete from rollup_touched where patient_id = :p and metric_id = :m and day = to_date(:d, 'YYYY-MM-DD')", key);
    }
    await this.connection.commit();
  }
}
