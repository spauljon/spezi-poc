-- In ANALYTICSPDB, as SYSDBA: tablespace, a schema-only OWNER (no login), and a separate
-- APPLICATION user (CREATE SESSION only), mirroring FHIRPDB.
--   @30-analytics-user.sql <OWNER> <APP_USER> <APP_PASSWORD>
-- No tables are created here: the analytics schema is loaded as the owner by the analytics
-- project (M9), which then reruns 25-grants-and-synonyms.sql for the application user.
-- UNTESTED until the next fresh `make stack-up` (the owner/app split is new).
set verify off feedback on
whenever sqlerror exit failure rollback

define owner = &1
define app = &2
define app_pwd = &3

alter session set db_create_file_dest = '/opt/oracle/oradata';
create tablespace poc_analytics_data datafile size 128m autoextend on next 64m maxsize 3g;

create user &owner no authentication
  default tablespace poc_analytics_data
  temporary tablespace temp
  quota unlimited on poc_analytics_data;

create user &app identified by "&app_pwd"
  default tablespace poc_analytics_data
  temporary tablespace temp;
grant create session to &app;

exit;
