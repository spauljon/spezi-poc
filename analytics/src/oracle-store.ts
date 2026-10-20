import oracledb, { type Connection } from "oracledb";
import type { IntakeTotal, StoredIntakeTotal } from "./intake.ts";
import type { SleepSession } from "./sleep.ts";
import { sameIntake, sameSession } from "./store.ts";
import type { Reader, Rollup, Store, StoredRollup, StoredSleepSession, Window } from "./store.ts";

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
export class OracleStore implements Store, Reader {
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

  async resetWatermark(worker: string): Promise<void> {
    await this.connection.execute("delete from rollup_watermark where worker_name = :w", { w: worker });
    await this.connection.commit();
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
                  n_artifact = :na, n_late = :nl, revision = revision + 1, updated_at = systimestamp
            where patient_id = :p and metric_id = :m and day = to_date(:d, 'YYYY-MM-DD')
              and (unit <> :u or n <> :n or min_value <> :lo or median_value <> :md or max_value <> :hi
                   or n_artifact <> :na or n_late <> :nl)`,
          { ...key, u: rollup.unit, n: rollup.n, lo: rollup.min, md: rollup.median, hi: rollup.max, na: rollup.nArtifact, nl: rollup.nLate },
        );
        changed = (updated.rowsAffected ?? 0) > 0;
        if (!changed) {
          const inserted = await this.connection.execute(
            `insert into daily_rollup (patient_id, metric_id, day, unit, n, min_value, median_value, max_value, n_artifact, n_late)
             select :p, :m, to_date(:d, 'YYYY-MM-DD'), :u, :n, :lo, :md, :hi, :na, :nl from dual
              where not exists (select 1 from daily_rollup
                                 where patient_id = :p and metric_id = :m and day = to_date(:d, 'YYYY-MM-DD'))`,
            { ...key, u: rollup.unit, n: rollup.n, lo: rollup.min, md: rollup.median, hi: rollup.max, na: rollup.nArtifact, nl: rollup.nLate },
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
    return this.selectRollups("(:p is null or patient_id = :p)", { p: patientId ?? null });
  }

  async bands(patientId: string, metricId: string, from: string, to: string): Promise<StoredRollup[]> {
    return this.selectRollups(
      "patient_id = :p and metric_id = :m and day >= to_date(:f, 'YYYY-MM-DD') and day <= to_date(:t, 'YYYY-MM-DD')",
      { p: patientId, m: metricId, f: from, t: to },
    );
  }

  async sleepNights(patientId: string, from: string, to: string): Promise<StoredSleepSession[]> {
    return (await this.nights(patientId)).filter((s) => s.night >= from && s.night <= to);
  }

  async pendingCount(patientId: string, metricIds: readonly string[], from: string, to: string): Promise<number> {
    let total = 0;
    for (const metric of metricIds) {
      const result = await this.connection.execute<{ N: number }>(
        `select count(*) as n from rollup_touched
          where patient_id = :p and metric_id = :m
            and day >= to_date(:f, 'YYYY-MM-DD') and day <= to_date(:t, 'YYYY-MM-DD')`,
        { p: patientId, m: metric, f: from, t: to },
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      );
      total += Number(result.rows?.[0]?.N ?? 0);
    }
    return total;
  }

  private async selectRollups(where: string, binds: Record<string, unknown>): Promise<StoredRollup[]> {
    const result = await this.connection.execute<{
      P: string; M: string; D: string; U: string; N: number; LO: number; MD: number; HI: number; NA: number; NL: number; R: number; UP: number;
    }>(
      `select patient_id as p, metric_id as m, to_char(day, 'YYYY-MM-DD') as d, unit as u, n,
              min_value as lo, median_value as md, max_value as hi, n_artifact as na, n_late as nl, revision as r,
              round((cast(sys_extract_utc(updated_at) as date) - date '1970-01-01') * 86400) * 1000 as up
         from daily_rollup
        where ${where}
        order by patient_id, metric_id, day`,
      binds,
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    return (result.rows ?? []).map((r) => ({
      patientId: r.P, metricId: r.M, day: r.D, unit: r.U,
      n: Number(r.N), min: Number(r.LO), median: Number(r.MD), max: Number(r.HI),
      nArtifact: Number(r.NA), nLate: Number(r.NL), revision: Number(r.R),
      updatedAtMs: Number(r.UP),
    }));
  }

  async applyNights(window: Window, sessions: readonly SleepSession[]): Promise<boolean> {
    const existing = new Map(
      (await this.nights(window.patientId)).filter((s) => s.night === window.day).map((s) => [s.sessionStartMs, s]),
    );
    const key = { p: window.patientId, d: window.day };
    try {
      let changed = false;
      const keep = new Set<number>();
      for (const s of sessions) {
        keep.add(s.sessionStartMs);
        const old = existing.get(s.sessionStartMs);
        if (old && sameSession(old, s)) {
          continue;
        }
        const binds = {
          ...key, b_st: s.sessionStartMs, b_en: s.sessionEndMs, b_on: s.onsetMs, b_la: s.lastAsleepEndMs,
          b_lat: s.latencyMin, b_wae: s.wakeAfterEndMin, b_asl: s.asleepMin, b_core: s.coreMin, b_deep: s.deepMin,
          b_rem: s.remMin, b_uns: s.unspecifiedMin, b_awk: s.awakeMin, b_unsc: s.unscoredMin, b_ovl: s.overlapMin,
          b_nawk: s.awakenings, b_ic: s.intervalCount, b_main: s.isMain ? 1 : 0,
        };
        if (old) {
          await this.connection.execute(
            `update sleep_session set session_end_ms = :b_en, onset_ms = :b_on, last_asleep_end_ms = :b_la,
                    latency_min = :b_lat, wake_after_end_min = :b_wae, asleep_min = :b_asl, core_min = :b_core,
                    deep_min = :b_deep, rem_min = :b_rem, unspecified_min = :b_uns, awake_min = :b_awk,
                    unscored_min = :b_unsc, overlap_min = :b_ovl, awakenings = :b_nawk, interval_count = :b_ic,
                    is_main = :b_main, revision = revision + 1, updated_at = systimestamp
              where patient_id = :p and night = to_date(:d, 'YYYY-MM-DD') and session_start_ms = :b_st`,
            binds,
          );
        } else {
          await this.connection.execute(
            `insert into sleep_session (patient_id, night, session_start_ms, session_end_ms, onset_ms,
                    last_asleep_end_ms, latency_min, wake_after_end_min, asleep_min, core_min, deep_min, rem_min,
                    unspecified_min, awake_min, unscored_min, overlap_min, awakenings, interval_count, is_main)
             values (:p, to_date(:d, 'YYYY-MM-DD'), :b_st, :b_en, :b_on, :b_la, :b_lat, :b_wae, :b_asl, :b_core, :b_deep, :b_rem,
                    :b_uns, :b_awk, :b_unsc, :b_ovl, :b_nawk, :b_ic, :b_main)`,
            binds,
          );
        }
        changed = true;
      }
      for (const start of existing.keys()) {
        if (!keep.has(start)) {
          await this.connection.execute(
            "delete from sleep_session where patient_id = :p and night = to_date(:d, 'YYYY-MM-DD') and session_start_ms = :b_st",
            { ...key, b_st: start },
          );
          changed = true;
        }
      }
      await this.connection.execute(
        "delete from rollup_touched where patient_id = :p and metric_id = :m and day = to_date(:d, 'YYYY-MM-DD')",
        { p: window.patientId, m: window.metricId, d: window.day },
      );
      await this.connection.commit();
      return changed;
    } catch (error) {
      await this.connection.rollback();
      throw error;
    }
  }

  async nights(patientId?: string): Promise<StoredSleepSession[]> {
    const result = await this.connection.execute<Record<string, number | string>>(
      `select patient_id, to_char(night, 'YYYY-MM-DD') as night, session_start_ms, session_end_ms, onset_ms,
              last_asleep_end_ms, latency_min, wake_after_end_min, asleep_min, core_min, deep_min, rem_min,
              unspecified_min, awake_min, unscored_min, overlap_min, awakenings, interval_count, is_main, revision,
              round((cast(sys_extract_utc(updated_at) as date) - date '1970-01-01') * 86400) * 1000 as updated_at_ms
         from sleep_session
        where (:p is null or patient_id = :p)
        order by patient_id, session_start_ms`,
      { p: patientId ?? null },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    return (result.rows ?? []).map((r) => ({
      patientId: String(r["PATIENT_ID"]), night: String(r["NIGHT"]),
      sessionStartMs: Number(r["SESSION_START_MS"]), sessionEndMs: Number(r["SESSION_END_MS"]),
      onsetMs: Number(r["ONSET_MS"]), lastAsleepEndMs: Number(r["LAST_ASLEEP_END_MS"]),
      latencyMin: Number(r["LATENCY_MIN"]), wakeAfterEndMin: Number(r["WAKE_AFTER_END_MIN"]),
      asleepMin: Number(r["ASLEEP_MIN"]), coreMin: Number(r["CORE_MIN"]), deepMin: Number(r["DEEP_MIN"]),
      remMin: Number(r["REM_MIN"]), unspecifiedMin: Number(r["UNSPECIFIED_MIN"]), awakeMin: Number(r["AWAKE_MIN"]),
      unscoredMin: Number(r["UNSCORED_MIN"]), overlapMin: Number(r["OVERLAP_MIN"]),
      awakenings: Number(r["AWAKENINGS"]), intervalCount: Number(r["INTERVAL_COUNT"]),
      isMain: Number(r["IS_MAIN"]) === 1, revision: Number(r["REVISION"]), updatedAtMs: Number(r["UPDATED_AT_MS"]),
    }));
  }

  async applyIntake(window: Window, totals: readonly IntakeTotal[]): Promise<boolean> {
    const existing = new Map(
      (await this.intakeTotals(window.patientId))
        .filter((t) => t.metricId === window.metricId && t.day === window.day)
        .map((t) => [t.meal, t]),
    );
    const key = { p: window.patientId, m: window.metricId, d: window.day };
    try {
      let changed = false;
      const keep = new Set<string>();
      for (const t of totals) {
        keep.add(t.meal);
        const old = existing.get(t.meal);
        if (old && sameIntake(old, t)) {
          continue;
        }
        const binds = {
          ...key, b_meal: t.meal, b_unit: t.unit, b_total: t.total, b_n: t.n, b_first: t.firstMs, b_last: t.lastMs,
          b_na: t.nArtifact, b_nl: t.nLate,
        };
        if (old) {
          await this.connection.execute(
            `update nutrition_daily set unit = :b_unit, total = :b_total, n = :b_n, first_ms = :b_first, last_ms = :b_last,
                    n_artifact = :b_na, n_late = :b_nl, revision = revision + 1, updated_at = systimestamp
              where patient_id = :p and metric_id = :m and day = to_date(:d, 'YYYY-MM-DD') and meal = :b_meal`,
            binds,
          );
        } else {
          await this.connection.execute(
            `insert into nutrition_daily (patient_id, metric_id, day, meal, unit, total, n, first_ms, last_ms, n_artifact, n_late)
             values (:p, :m, to_date(:d, 'YYYY-MM-DD'), :b_meal, :b_unit, :b_total, :b_n, :b_first, :b_last, :b_na, :b_nl)`,
            binds,
          );
        }
        changed = true;
      }
      for (const meal of existing.keys()) {
        if (!keep.has(meal)) {
          await this.connection.execute(
            "delete from nutrition_daily where patient_id = :p and metric_id = :m and day = to_date(:d, 'YYYY-MM-DD') and meal = :b_meal",
            { ...key, b_meal: meal },
          );
          changed = true;
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

  async intakeTotals(patientId?: string): Promise<StoredIntakeTotal[]> {
    const result = await this.connection.execute<Record<string, number | string>>(
      `select patient_id, metric_id, to_char(day, 'YYYY-MM-DD') as day, meal, unit, total, n, first_ms, last_ms,
              n_artifact, n_late, revision,
              round((cast(sys_extract_utc(updated_at) as date) - date '1970-01-01') * 86400) * 1000 as updated_at_ms
         from nutrition_daily
        where (:p is null or patient_id = :p)
        order by patient_id, metric_id, day, meal`,
      { p: patientId ?? null },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    );
    return (result.rows ?? []).map((r) => ({
      patientId: String(r["PATIENT_ID"]), metricId: String(r["METRIC_ID"]), day: String(r["DAY"]), meal: String(r["MEAL"]),
      unit: String(r["UNIT"]), total: Number(r["TOTAL"]), n: Number(r["N"]),
      firstMs: Number(r["FIRST_MS"]), lastMs: Number(r["LAST_MS"]),
      nArtifact: Number(r["N_ARTIFACT"]), nLate: Number(r["N_LATE"]),
      revision: Number(r["REVISION"]), updatedAtMs: Number(r["UPDATED_AT_MS"]),
    }));
  }

  async intakeDays(patientId: string, metricId: string, from: string, to: string): Promise<StoredIntakeTotal[]> {
    return (await this.intakeTotals(patientId)).filter((t) => t.metricId === metricId && t.day >= from && t.day <= to);
  }

  /** Test support: remove one worker's watermark and the given windows' rows. */
  async purge(worker: string, windows: readonly Window[]): Promise<void> {
    await this.connection.execute("delete from rollup_watermark where worker_name = :w", { w: worker });
    for (const w of windows) {
      const key = { p: w.patientId, m: w.metricId, d: w.day };
      await this.connection.execute(
        "delete from sleep_session where patient_id = :p and night = to_date(:d, 'YYYY-MM-DD')",
        { p: w.patientId, d: w.day });
      await this.connection.execute(
        "delete from daily_rollup where patient_id = :p and metric_id = :m and day = to_date(:d, 'YYYY-MM-DD')", key);
      await this.connection.execute(
        "delete from nutrition_daily where patient_id = :p and metric_id = :m and day = to_date(:d, 'YYYY-MM-DD')", key);
      await this.connection.execute(
        "delete from rollup_touched where patient_id = :p and metric_id = :m and day = to_date(:d, 'YYYY-MM-DD')", key);
    }
    await this.connection.commit();
  }
}
