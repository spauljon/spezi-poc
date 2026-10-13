-- Analytic store schema (M9), applied by db/init.sh (in the oracle container, on every start) as SYS into the no-login owner account.
-- Idempotent: ORA-00955 (name already used) is the only error tolerated, per object.
-- Usage: @10-schema.sql <owner>
set verify off feedback on serveroutput on
whenever sqlerror exit failure rollback

define owner = &1

declare
  procedure ddl(p_sql varchar2) is
  begin
    execute immediate p_sql;
  exception
    when others then
      if sqlcode != -955 then
        raise;
      end if;
  end;
begin
  -- One row per patient, metric and UTC day. The day is a plain DATE at 00:00 (checked); the rollup day is UTC by
  -- decision (assumption A6, see analytics/README.md), so no time zone is stored or needed.
  ddl('create table &owner..daily_rollup (
         patient_id    varchar2(64)  not null,
         metric_id     varchar2(40)  not null,
         day           date          not null,
         unit          varchar2(32)  not null,
         n             number(10)    not null,
         min_value     binary_double not null,
         median_value  binary_double not null,
         max_value     binary_double not null,
         revision      number(10)    default 1 not null,
         updated_at    timestamp(3) with time zone default systimestamp not null,
         constraint daily_rollup_pk primary key (patient_id, metric_id, day),
         constraint daily_rollup_day_ck check (day = trunc(day)),
         constraint daily_rollup_n_ck check (n > 0)
       )');

  -- Windows that changed and are waiting to be recomputed. Written in the same transaction as the watermark advance,
  -- so a crash between "saw the change" and "recomputed it" loses nothing.
  ddl('create table &owner..rollup_touched (
         patient_id  varchar2(64) not null,
         metric_id   varchar2(40) not null,
         day         date         not null,
         touched_at  timestamp(3) with time zone default systimestamp not null,
         constraint rollup_touched_pk primary key (patient_id, metric_id, day)
       )');

  -- How far the worker has read HAPI, as epoch milliseconds of the newest Observation.meta.lastUpdated it saw.
  ddl('create table &owner..rollup_watermark (
         worker_name      varchar2(64) not null,
         last_updated_ms  number(16)   not null,
         updated_at       timestamp(3) with time zone default systimestamp not null,
         constraint rollup_watermark_pk primary key (worker_name)
       )');

  -- One row per sleep session (M10), grouped under the UTC date of the final waking. Several sessions can share a
  -- date (a nap); `is_main` marks the one with the most time asleep. Instants are epoch milliseconds, durations are
  -- minutes. A session's start can change when a late interval merges it with its neighbour, so the key includes it
  -- and the worker replaces all rows of a (patient, night) as a set.
  ddl('create table &owner..sleep_session (
         patient_id          varchar2(64)  not null,
         night               date          not null,
         session_start_ms    number(16)    not null,
         session_end_ms      number(16)    not null,
         onset_ms            number(16)    not null,
         last_asleep_end_ms  number(16)    not null,
         latency_min         binary_double not null,
         wake_after_end_min  binary_double not null,
         asleep_min          binary_double not null,
         core_min            binary_double not null,
         deep_min            binary_double not null,
         rem_min             binary_double not null,
         unspecified_min     binary_double not null,
         awake_min           binary_double not null,
         unscored_min        binary_double not null,
         overlap_min         binary_double not null,
         awakenings          number(5)     not null,
         interval_count      number(6)     not null,
         is_main             number(1)     not null,
         revision            number(10)    default 1 not null,
         updated_at          timestamp(3) with time zone default systimestamp not null,
         constraint sleep_session_pk primary key (patient_id, night, session_start_ms),
         constraint sleep_session_night_ck check (night = trunc(night)),
         constraint sleep_session_main_ck check (is_main in (0, 1))
       )');

  dbms_output.put_line('analytics schema present in ' || upper('&owner'));
end;
/

exit;
