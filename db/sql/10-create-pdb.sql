-- Create and open a pluggable database from the seed. Run in the CDB root as SYSDBA.
--   @10-create-pdb.sql <PDB_NAME> <PDB_ADMIN_PASSWORD>
-- The seed datafile directory is discovered from the data dictionary instead of hardcoded
-- (the target directory is the seed directory with 'pdbseed' replaced by the PDB name).
-- Ran cleanly on first `make stack-up` (2026-10-08).
set verify off feedback on
whenever sqlerror exit failure rollback

define pdb_name = &1
define pdb_pwd = &2

column seed_dir new_value seed_dir noprint
column tgt_dir new_value tgt_dir noprint
select substr(name, 1, instr(name, '/', -1)) as seed_dir,
       regexp_replace(substr(name, 1, instr(name, '/', -1)), 'pdbseed', lower('&pdb_name'), 1, 1, 'i') as tgt_dir
from v$datafile
where con_id = (select con_id from v$pdbs where name = 'PDB$SEED')
fetch first 1 row only;

create pluggable database &pdb_name admin user pdbadmin identified by "&pdb_pwd"
  file_name_convert = ('&seed_dir', '&tgt_dir');

alter pluggable database &pdb_name open;
-- Reopen automatically when the container restarts.
alter pluggable database &pdb_name save state;

exit;
