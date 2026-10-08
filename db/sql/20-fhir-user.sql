-- In FHIRPDB, as SYSDBA: tablespace, a schema-only OWNER (no login) that holds every object, and a
-- separate APPLICATION user (CREATE SESSION only) that HAPI connects as.
--   @20-fhir-user.sql <OWNER> <APP_USER> <APP_PASSWORD> <PATH_TO_HAPI_DDL> <PATH_TO_TEMP_TABLES_DDL>
-- All DDL is loaded here, as SYS, through current_schema = the owner. The application user gets its
-- DML grants and synonyms from 25-grants-and-synonyms.sql (run by init.sh afterwards).
-- UNTESTED until the next fresh `make stack-up` (the owner/app split is new).
set verify off feedback on
whenever sqlerror exit failure rollback

define owner = &1
define app = &2
define app_pwd = &3
define ddl_path = &4
define temp_ddl_path = &5

-- A new PDB cloned from the seed may have no USERS tablespace [UNVERIFIED], so create our own.
-- Size caps are a budget inside the instance-wide Free-edition limit (see db/README.md).
alter session set db_create_file_dest = '/opt/oracle/oradata';
create tablespace poc_fhir_data datafile size 256m autoextend on next 128m maxsize 6g;

-- Schema owner: owns the data, cannot log in.
create user &owner no authentication
  default tablespace poc_fhir_data
  temporary tablespace temp
  quota unlimited on poc_fhir_data;

-- Application user: owns nothing, so it needs no quota.
create user &app identified by "&app_pwd"
  default tablespace poc_fhir_data
  temporary tablespace temp;
grant create session to &app;

alter session set current_schema = &owner;
@&ddl_path
-- Hibernate's temporary id tables, pre-created so HAPI never needs CREATE TABLE.
@&temp_ddl_path

exit;
