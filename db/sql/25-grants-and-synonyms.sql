-- Gives the application user DML on every table and SELECT on every sequence of the schema
-- owner, plus a private synonym for each, so unqualified names resolve (no default_schema needed).
-- Run as SYSDBA inside the PDB. Idempotent: rerun after any change to the owner's objects
-- (for example a HAPI upgrade that adds tables or sequences).
--   @25-grants-and-synonyms.sql <OWNER> <APP_USER>
-- Deliberately not granted: DDL, TRUNCATE, DROP, or anything on objects other than the owner's.
-- UNTESTED until the next fresh `make stack-up`.
set verify off feedback off serveroutput on
whenever sqlerror exit failure rollback

define owner = &1
define app = &2

declare
  v_owner constant varchar2(128) := upper('&owner');
  v_app   constant varchar2(128) := upper('&app');
  n_tab   pls_integer := 0;
  n_seq   pls_integer := 0;
  function q(p_name varchar2) return varchar2 is
  begin
    return dbms_assert.enquote_name(p_name, false);
  end;
begin
  for t in (select table_name from dba_tables where owner = v_owner order by table_name) loop
    execute immediate 'grant select, insert, update, delete on ' || q(v_owner) || '.' || q(t.table_name) || ' to ' || q(v_app);
    execute immediate 'create or replace synonym ' || q(v_app) || '.' || q(t.table_name) || ' for ' || q(v_owner) || '.' || q(t.table_name);
    n_tab := n_tab + 1;
  end loop;

  for s in (select sequence_name from dba_sequences where sequence_owner = v_owner order by sequence_name) loop
    execute immediate 'grant select on ' || q(v_owner) || '.' || q(s.sequence_name) || ' to ' || q(v_app);
    execute immediate 'create or replace synonym ' || q(v_app) || '.' || q(s.sequence_name) || ' for ' || q(v_owner) || '.' || q(s.sequence_name);
    n_seq := n_seq + 1;
  end loop;

  dbms_output.put_line('grants and synonyms for ' || v_app || ' on ' || v_owner || ': ' || n_tab || ' tables, ' || n_seq || ' sequences');
end;
/

exit;
