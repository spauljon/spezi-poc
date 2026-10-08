
create sequence SEQ_BLKEXCOL_PID start with 1 increment by 50;

create sequence SEQ_BLKEXCOLFILE_PID start with 1 increment by 50;

create sequence SEQ_BLKEXJOB_PID start with 1 increment by 50;

create sequence SEQ_BLKIMJOB_PID start with 1 increment by 50;

create sequence SEQ_BLKIMJOBFILE_PID start with 1 increment by 50;

create sequence SEQ_CNCPT_MAP_GRP_ELM_TGT_PID start with 1 increment by 50;

create sequence SEQ_CODESYSTEM_PID start with 1 increment by 50;

create sequence SEQ_CODESYSTEMVER_PID start with 1 increment by 50;

create sequence SEQ_CONCEPT_DESIG_PID start with 1 increment by 50;

create sequence SEQ_CONCEPT_MAP_GROUP_PID start with 1 increment by 50;

create sequence SEQ_CONCEPT_MAP_GRP_ELM_PID start with 1 increment by 50;

create sequence SEQ_CONCEPT_MAP_PID start with 1 increment by 50;

create sequence SEQ_CONCEPT_PC_PID start with 1 increment by 50;

create sequence SEQ_CONCEPT_PID start with 1 increment by 50;

create sequence SEQ_CONCEPT_PROP_PID start with 1 increment by 50;

create sequence SEQ_EMPI_LINK_ID start with 1 increment by 50;

create sequence SEQ_FORCEDID_ID start with 1 increment by 50;

create sequence SEQ_HFJ_REVINFO start with 1 increment by 50;

create sequence SEQ_HISTORYTAG_ID start with 1 increment by 50;

create sequence SEQ_IDXCMBTOKNU_ID start with 1 increment by 50;

create sequence SEQ_IDXCMPSTRUNIQ_ID start with 1 increment by 50;

create sequence SEQ_NPM_PACK start with 1 increment by 50;

create sequence SEQ_NPM_PACKVER start with 1 increment by 50;

create sequence SEQ_NPM_PACKVERRES start with 1 increment by 50;

create sequence SEQ_RES_REINDEX_JOB start with 1 increment by 50;

create sequence SEQ_RESLINK_ID start with 1 increment by 50;

create sequence SEQ_RESOURCE_HISTORY_ID start with 1 increment by 50;

create sequence SEQ_RESOURCE_ID start with 1 increment by 50;

create sequence SEQ_RESPARMPRESENT_ID start with 1 increment by 50;

create sequence SEQ_RESTAG_ID start with 1 increment by 50;

create sequence SEQ_SEARCH start with 1 increment by 50;

create sequence SEQ_SEARCH_INC start with 1 increment by 50;

create sequence SEQ_SEARCH_RES start with 1 increment by 50;

create sequence SEQ_SPIDX_COORDS start with 1 increment by 50;

create sequence SEQ_SPIDX_DATE start with 1 increment by 50;

create sequence SEQ_SPIDX_NUMBER start with 1 increment by 50;

create sequence SEQ_SPIDX_QUANTITY start with 1 increment by 50;

create sequence SEQ_SPIDX_QUANTITY_NRML start with 1 increment by 50;

create sequence SEQ_SPIDX_STRING start with 1 increment by 50;

create sequence SEQ_SPIDX_TOKEN start with 1 increment by 50;

create sequence SEQ_SPIDX_URI start with 1 increment by 50;

create sequence SEQ_SUBSCRIPTION_ID start with 1 increment by 50;

create sequence SEQ_TAGDEF_ID start with 1 increment by 50;

create sequence SEQ_VALUESET_C_DSGNTN_PID start with 1 increment by 50;

create sequence SEQ_VALUESET_CONCEPT_PID start with 1 increment by 50;

create sequence SEQ_VALUESET_PID start with 1 increment by 50;

create table BT2_JOB_INSTANCE (
                                  ID varchar2(100 char) not null,
                                  JOB_CANCELLED number(1,0) not null,
                                  CMB_RECS_PROCESSED number(10,0),
                                  CMB_RECS_PER_SEC float(53),
                                  CREATE_TIME timestamp(6) not null,
                                  CUR_GATED_STEP_ID varchar2(100 char),
                                  DEFINITION_ID varchar2(100 char) not null,
                                  DEFINITION_VER number(10,0) not null,
                                  END_TIME timestamp(6),
                                  ERROR_COUNT number(10,0) not null,
                                  ERROR_MSG varchar2(500 char),
                                  EST_REMAINING varchar2(100 char),
                                  FAST_TRACKING number(1,0),
                                  PARAMS_JSON varchar2(2000 char),
                                  PARAMS_JSON_LOB clob,
                                  PARAMS_JSON_VC clob,
                                  PROGRESS_PCT float(53) not null,
                                  REPORT clob,
                                  REPORT_VC clob,
                                  START_TIME timestamp(6),
                                  STAT varchar2(20 char) not null,
                                  TOT_ELAPSED_MILLIS number(10,0),
                                  CLIENT_ID varchar2(200 char),
                                  USER_NAME varchar2(200 char),
                                  UPDATE_TIME timestamp(6),
                                  WARNING_MSG varchar2(4000 char),
                                  WORK_CHUNKS_PURGED number(1,0) not null,
                                  primary key (ID)
);

create table BT2_WORK_CHUNK (
                                ID varchar2(100 char) not null,
                                CREATE_TIME timestamp(6) not null,
                                END_TIME timestamp(6),
                                ERROR_COUNT number(10,0) not null,
                                ERROR_MSG varchar2(500 char),
                                INSTANCE_ID varchar2(100 char) not null,
                                DEFINITION_ID varchar2(100 char) not null,
                                DEFINITION_VER number(10,0) not null,
                                NEXT_POLL_TIME timestamp(6),
                                POLL_ATTEMPTS number(10,0),
                                RECORDS_PROCESSED number(10,0),
                                SEQ number(10,0) not null,
                                CHUNK_DATA clob,
                                CHUNK_DATA_VC clob,
                                START_TIME timestamp(6),
                                STAT varchar2(20 char) not null,
                                TGT_STEP_ID varchar2(100 char) not null,
                                UPDATE_TIME timestamp(6),
                                WARNING_MSG varchar2(4000 char),
                                primary key (ID)
);

create table HFJ_BINARY_STORAGE_BLOB (
                                         BLOB_ID varchar2(200 char) not null,
                                         BLOB_DATA blob,
                                         CONTENT_TYPE varchar2(100 char) not null,
                                         BLOB_HASH varchar2(128 char),
                                         PUBLISHED_DATE timestamp(6) not null,
                                         RESOURCE_ID varchar2(100 char) not null,
                                         BLOB_SIZE number(19,0) not null,
                                         STORAGE_CONTENT_BIN blob,
                                         primary key (BLOB_ID)
);

create table HFJ_BLK_EXPORT_COLFILE (
                                        PID number(19,0) not null,
                                        RES_ID varchar2(100 char) not null,
                                        COLLECTION_PID number(19,0) not null,
                                        primary key (PID)
);

create table HFJ_BLK_EXPORT_COLLECTION (
                                           PID number(19,0) not null,
                                           TYPE_FILTER varchar2(1000 char),
                                           RES_TYPE varchar2(40 char) not null,
                                           OPTLOCK number(10,0) not null,
                                           JOB_PID number(19,0) not null,
                                           primary key (PID)
);

create table HFJ_BLK_EXPORT_JOB (
                                    PID number(19,0) not null,
                                    CREATED_TIME timestamp(6) not null,
                                    EXP_TIME timestamp(6),
                                    JOB_ID varchar2(36 char) not null,
                                    REQUEST varchar2(1024 char) not null,
                                    EXP_SINCE timestamp(6),
                                    JOB_STATUS varchar2(10 char) not null,
                                    STATUS_MESSAGE varchar2(500 char),
                                    STATUS_TIME timestamp(6) not null,
                                    OPTLOCK number(10,0) not null,
                                    primary key (PID),
                                    constraint IDX_BLKEX_JOB_ID unique (JOB_ID)
);

create table HFJ_BLK_IMPORT_JOB (
                                    PID number(19,0) not null,
                                    BATCH_SIZE number(10,0) not null,
                                    FILE_COUNT number(10,0) not null,
                                    JOB_DESC varchar2(500 char),
                                    JOB_ID varchar2(36 char) not null,
                                    ROW_PROCESSING_MODE varchar2(20 char) not null,
                                    JOB_STATUS varchar2(10 char) not null,
                                    STATUS_MESSAGE varchar2(500 char),
                                    STATUS_TIME timestamp(6) not null,
                                    OPTLOCK number(10,0) not null,
                                    primary key (PID),
                                    constraint IDX_BLKIM_JOB_ID unique (JOB_ID)
);

create table HFJ_BLK_IMPORT_JOBFILE (
                                        PID number(19,0) not null,
                                        JOB_CONTENTS blob,
                                        JOB_CONTENTS_VC clob,
                                        FILE_DESCRIPTION varchar2(500 char),
                                        FILE_SEQ number(10,0) not null,
                                        TENANT_NAME varchar2(200 char),
                                        JOB_PID number(19,0) not null,
                                        primary key (PID)
);

create table HFJ_FORCED_ID (
                               PID number(19,0) not null,
                               PARTITION_DATE date,
                               PARTITION_ID number(10,0),
                               FORCED_ID varchar2(100 char) not null,
                               RESOURCE_PID number(19,0) not null,
                               RESOURCE_TYPE varchar2(100 char) default '',
                               primary key (PID)
);

create table HFJ_HISTORY_TAG (
                                 PID number(19,0) not null,
                                 PARTITION_DATE date,
                                 PARTITION_ID number(10,0),
                                 TAG_ID number(19,0),
                                 RES_VER_PID number(19,0) not null,
                                 RES_ID number(19,0) not null,
                                 RES_TYPE varchar2(40 char) not null,
                                 primary key (PID),
                                 constraint IDX_RESHISTTAG_TAGID unique (RES_VER_PID, TAG_ID)
);

create table HFJ_IDX_CMB_TOK_NU (
                                    PID number(19,0) not null,
                                    PARTITION_DATE date,
                                    PARTITION_ID number(10,0),
                                    HASH_COMPLETE number(19,0) not null,
                                    IDX_STRING varchar2(500 char) not null,
                                    RES_ID number(19,0),
                                    primary key (PID)
);

create table HFJ_IDX_CMP_STRING_UNIQ (
                                         PID number(19,0) not null,
                                         PARTITION_DATE date,
                                         PARTITION_ID number(10,0),
                                         HASH_COMPLETE number(19,0),
                                         HASH_COMPLETE_2 number(19,0),
                                         IDX_STRING varchar2(500 char) not null,
                                         RES_ID number(19,0),
                                         primary key (PID),
                                         constraint IDX_IDXCMPSTRUNIQ_STRING unique (IDX_STRING)
);

create table HFJ_PARTITION (
                               PART_ID number(10,0) not null,
                               PART_DESC varchar2(200 char),
                               PART_NAME varchar2(200 char) not null,
                               primary key (PART_ID),
                               constraint IDX_PART_NAME unique (PART_NAME)
);

create table HFJ_RES_LINK (
                              PID number(19,0) not null,
                              PARTITION_DATE date,
                              PARTITION_ID number(10,0),
                              SRC_PATH varchar2(500 char) not null,
                              SRC_RESOURCE_ID number(19,0) not null,
                              SOURCE_RESOURCE_TYPE varchar2(40 char) not null,
                              TARGET_RES_PARTITION_DATE date,
                              TARGET_RES_PARTITION_ID number(10,0),
                              TARGET_RESOURCE_ID number(19,0),
                              TARGET_RESOURCE_TYPE varchar2(40 char) not null,
                              TARGET_RESOURCE_URL varchar2(200 char),
                              TARGET_RESOURCE_VERSION number(19,0),
                              SP_UPDATED timestamp(6),
                              primary key (PID)
);

create table HFJ_RES_PARAM_PRESENT (
                                       PID number(19,0) not null,
                                       PARTITION_DATE date,
                                       PARTITION_ID number(10,0),
                                       HASH_PRESENCE number(19,0),
                                       SP_PRESENT number(1,0) not null,
                                       RES_ID number(19,0) not null,
                                       primary key (PID)
);

create table HFJ_RES_REINDEX_JOB (
                                     PID number(19,0) not null,
                                     JOB_DELETED number(1,0) not null,
                                     REINDEX_COUNT number(10,0),
                                     RES_TYPE varchar2(100 char),
                                     SUSPENDED_UNTIL timestamp(6),
                                     UPDATE_THRESHOLD_HIGH timestamp(6) not null,
                                     UPDATE_THRESHOLD_LOW timestamp(6),
                                     primary key (PID)
);

create table HFJ_RES_SEARCH_URL (
                                    RES_SEARCH_URL varchar2(768 char) not null,
                                    PARTITION_ID number(10,0) not null,
                                    CREATED_TIME timestamp(6) not null,
                                    PARTITION_DATE date,
                                    RES_ID number(19,0) not null,
                                    primary key (RES_SEARCH_URL, PARTITION_ID)
);

create table HFJ_RES_TAG (
                             PID number(19,0) not null,
                             PARTITION_DATE date,
                             PARTITION_ID number(10,0),
                             TAG_ID number(19,0),
                             RES_ID number(19,0),
                             RES_TYPE varchar2(40 char) not null,
                             primary key (PID),
                             constraint IDX_RESTAG_TAGID unique (RES_ID, TAG_ID)
);

create table HFJ_RES_VER (
                             PID number(19,0) not null,
                             PARTITION_DATE date,
                             PARTITION_ID number(10,0),
                             RES_DELETED_AT timestamp(6),
                             RES_VERSION varchar2(7 char),
                             HAS_TAGS number(1,0) not null,
                             RES_PUBLISHED timestamp(6) not null,
                             RES_UPDATED timestamp(6) not null,
                             RES_ENCODING varchar2(5 char) not null,
                             REQUEST_ID varchar2(16 char),
                             RES_TEXT blob,
                             RES_ID number(19,0) not null,
                             RES_TEXT_VC clob,
                             RES_TYPE varchar2(40 char) not null,
                             RES_VER number(19,0) not null,
                             SOURCE_URI varchar2(768 char),
                             primary key (PID),
                             constraint IDX_RESVER_ID_VER unique (RES_ID, RES_VER)
);

create table HFJ_RES_VER_PROV (
                                  RES_VER_PID number(19,0) not null,
                                  PARTITION_DATE date,
                                  PARTITION_ID number(10,0),
                                  REQUEST_ID varchar2(16 char),
                                  SOURCE_URI varchar2(768 char),
                                  RES_PID number(19,0) not null,
                                  primary key (RES_VER_PID)
);

create table HFJ_RESOURCE (
                              RES_ID number(19,0) not null,
                              PARTITION_DATE date,
                              PARTITION_ID number(10,0),
                              RES_DELETED_AT timestamp(6),
                              RES_VERSION varchar2(7 char),
                              HAS_TAGS number(1,0) not null,
                              RES_PUBLISHED timestamp(6) not null,
                              RES_UPDATED timestamp(6) not null,
                              FHIR_ID varchar2(64 char),
                              SP_HAS_LINKS number(1,0) not null,
                              HASH_SHA256 varchar2(64 char),
                              SP_INDEX_STATUS number(19,0),
                              RES_LANGUAGE varchar2(20 char),
                              SP_CMPSTR_UNIQ_PRESENT number(1,0),
                              SP_CMPTOKS_PRESENT number(1,0),
                              SP_COORDS_PRESENT number(1,0) not null,
                              SP_DATE_PRESENT number(1,0) not null,
                              SP_NUMBER_PRESENT number(1,0) not null,
                              SP_QUANTITY_NRML_PRESENT number(1,0) not null,
                              SP_QUANTITY_PRESENT number(1,0) not null,
                              SP_STRING_PRESENT number(1,0) not null,
                              SP_TOKEN_PRESENT number(1,0) not null,
                              SP_URI_PRESENT number(1,0) not null,
                              RES_TYPE varchar2(40 char) not null,
                              SEARCH_URL_PRESENT number(1,0),
                              RES_VER number(19,0) not null,
                              primary key (RES_ID),
                              constraint IDX_RES_TYPE_FHIR_ID unique (RES_TYPE, FHIR_ID)
);

create table HFJ_RESOURCE_MODIFIED (
                                       RES_ID varchar2(256 char) not null,
                                       RES_VER varchar2(8 char) not null,
                                       CREATED_TIME timestamp(6) not null,
                                       RESOURCE_TYPE varchar2(40 char) not null,
                                       SUMMARY_MESSAGE varchar2(4000 char) not null,
                                       primary key (RES_ID, RES_VER)
);

create table HFJ_REVINFO (
                             REV number(19,0) not null,
                             REVTSTMP timestamp(6),
                             primary key (REV)
);

create table HFJ_SEARCH (
                            PID number(19,0) not null,
                            CREATED timestamp(6) not null,
                            SEARCH_DELETED number(1,0),
                            EXPIRY_OR_NULL timestamp(6),
                            FAILURE_CODE number(10,0),
                            FAILURE_MESSAGE varchar2(500 char),
                            LAST_UPDATED_HIGH timestamp(6),
                            LAST_UPDATED_LOW timestamp(6),
                            NUM_BLOCKED number(10,0),
                            NUM_FOUND number(10,0) not null,
                            PREFERRED_PAGE_SIZE number(10,0),
                            RESOURCE_ID number(19,0),
                            RESOURCE_TYPE varchar2(200 char),
                            SEARCH_PARAM_MAP blob,
                            SEARCH_PARAM_MAP_BIN blob,
                            SEARCH_QUERY_STRING clob,
                            SEARCH_QUERY_STRING_HASH number(10,0),
                            SEARCH_QUERY_STRING_VC clob,
                            SEARCH_TYPE number(10,0) not null,
                            SEARCH_STATUS varchar2(10 char) not null,
                            TOTAL_COUNT number(10,0),
                            SEARCH_UUID varchar2(48 char) not null,
                            OPTLOCK_VERSION number(10,0),
                            primary key (PID),
                            constraint IDX_SEARCH_UUID unique (SEARCH_UUID)
);

create table HFJ_SEARCH_INCLUDE (
                                    PID number(19,0) not null,
                                    SEARCH_INCLUDE varchar2(200 char) not null,
                                    INC_RECURSE number(1,0) not null,
                                    REVINCLUDE number(1,0) not null,
                                    SEARCH_PID number(19,0) not null,
                                    primary key (PID)
);

create table HFJ_SEARCH_RESULT (
                                   PID number(19,0) not null,
                                   SEARCH_ORDER number(10,0) not null,
                                   RESOURCE_PID number(19,0) not null,
                                   SEARCH_PID number(19,0) not null,
                                   primary key (PID),
                                   constraint IDX_SEARCHRES_ORDER unique (SEARCH_PID, SEARCH_ORDER)
);

create table HFJ_SPIDX_COORDS (
                                  SP_ID number(19,0) not null,
                                  PARTITION_DATE date,
                                  PARTITION_ID number(10,0),
                                  HASH_IDENTITY number(19,0),
                                  SP_MISSING number(1,0) not null,
                                  SP_NAME varchar2(100 char),
                                  RES_ID number(19,0) not null,
                                  RES_TYPE varchar2(100 char),
                                  SP_UPDATED timestamp(6),
                                  SP_LATITUDE float(53),
                                  SP_LONGITUDE float(53),
                                  primary key (SP_ID)
);

create table HFJ_SPIDX_DATE (
                                SP_ID number(19,0) not null,
                                PARTITION_DATE date,
                                PARTITION_ID number(10,0),
                                HASH_IDENTITY number(19,0),
                                SP_MISSING number(1,0) not null,
                                SP_NAME varchar2(100 char),
                                RES_ID number(19,0) not null,
                                RES_TYPE varchar2(100 char),
                                SP_UPDATED timestamp(6),
                                SP_VALUE_HIGH timestamp(6),
                                SP_VALUE_HIGH_DATE_ORDINAL number(10,0),
                                SP_VALUE_LOW timestamp(6),
                                SP_VALUE_LOW_DATE_ORDINAL number(10,0),
                                primary key (SP_ID)
);

create table HFJ_SPIDX_NUMBER (
                                  SP_ID number(19,0) not null,
                                  PARTITION_DATE date,
                                  PARTITION_ID number(10,0),
                                  HASH_IDENTITY number(19,0),
                                  SP_MISSING number(1,0) not null,
                                  SP_NAME varchar2(100 char),
                                  RES_ID number(19,0) not null,
                                  RES_TYPE varchar2(100 char),
                                  SP_UPDATED timestamp(6),
                                  SP_VALUE number(19,2),
                                  primary key (SP_ID)
);

create table HFJ_SPIDX_QUANTITY (
                                    SP_ID number(19,0) not null,
                                    PARTITION_DATE date,
                                    PARTITION_ID number(10,0),
                                    HASH_IDENTITY number(19,0),
                                    SP_MISSING number(1,0) not null,
                                    SP_NAME varchar2(100 char),
                                    RES_ID number(19,0) not null,
                                    RES_TYPE varchar2(100 char),
                                    SP_UPDATED timestamp(6),
                                    HASH_IDENTITY_AND_UNITS number(19,0),
                                    HASH_IDENTITY_SYS_UNITS number(19,0),
                                    SP_SYSTEM varchar2(200 char),
                                    SP_UNITS varchar2(200 char),
                                    SP_VALUE float(53),
                                    primary key (SP_ID)
);

create table HFJ_SPIDX_QUANTITY_NRML (
                                         SP_ID number(19,0) not null,
                                         PARTITION_DATE date,
                                         PARTITION_ID number(10,0),
                                         HASH_IDENTITY number(19,0),
                                         SP_MISSING number(1,0) not null,
                                         SP_NAME varchar2(100 char),
                                         RES_ID number(19,0) not null,
                                         RES_TYPE varchar2(100 char),
                                         SP_UPDATED timestamp(6),
                                         HASH_IDENTITY_AND_UNITS number(19,0),
                                         HASH_IDENTITY_SYS_UNITS number(19,0),
                                         SP_SYSTEM varchar2(200 char),
                                         SP_UNITS varchar2(200 char),
                                         SP_VALUE float(53),
                                         primary key (SP_ID)
);

create table HFJ_SPIDX_STRING (
                                  SP_ID number(19,0) not null,
                                  PARTITION_DATE date,
                                  PARTITION_ID number(10,0),
                                  HASH_IDENTITY number(19,0),
                                  SP_MISSING number(1,0) not null,
                                  SP_NAME varchar2(100 char),
                                  RES_ID number(19,0) not null,
                                  RES_TYPE varchar2(100 char),
                                  SP_UPDATED timestamp(6),
                                  HASH_EXACT number(19,0),
                                  HASH_NORM_PREFIX number(19,0),
                                  SP_VALUE_EXACT varchar2(768 char),
                                  SP_VALUE_NORMALIZED varchar2(768 char),
                                  primary key (SP_ID)
);

create table HFJ_SPIDX_TOKEN (
                                 SP_ID number(19,0) not null,
                                 PARTITION_DATE date,
                                 PARTITION_ID number(10,0),
                                 HASH_IDENTITY number(19,0),
                                 SP_MISSING number(1,0) not null,
                                 SP_NAME varchar2(100 char),
                                 RES_ID number(19,0) not null,
                                 RES_TYPE varchar2(100 char),
                                 SP_UPDATED timestamp(6),
                                 HASH_SYS number(19,0),
                                 HASH_SYS_AND_VALUE number(19,0),
                                 HASH_VALUE number(19,0),
                                 SP_SYSTEM varchar2(200 char),
                                 SP_VALUE varchar2(200 char),
                                 primary key (SP_ID)
);

create table HFJ_SPIDX_URI (
                               SP_ID number(19,0) not null,
                               PARTITION_DATE date,
                               PARTITION_ID number(10,0),
                               HASH_IDENTITY number(19,0),
                               SP_MISSING number(1,0) not null,
                               SP_NAME varchar2(100 char),
                               RES_ID number(19,0) not null,
                               RES_TYPE varchar2(100 char),
                               SP_UPDATED timestamp(6),
                               HASH_URI number(19,0),
                               SP_URI varchar2(500 char),
                               primary key (SP_ID)
);

create table HFJ_SUBSCRIPTION_STATS (
                                        PID number(19,0) not null,
                                        CREATED_TIME timestamp(6) not null,
                                        RES_ID number(19,0),
                                        primary key (PID),
                                        constraint IDX_SUBSC_RESID unique (RES_ID)
);

create table HFJ_TAG_DEF (
                             TAG_ID number(19,0) not null,
                             TAG_CODE varchar2(200 char),
                             TAG_DISPLAY varchar2(200 char),
                             TAG_SYSTEM varchar2(200 char),
                             TAG_TYPE number(10,0) not null,
                             TAG_USER_SELECTED number(1,0),
                             TAG_VERSION varchar2(30 char),
                             primary key (TAG_ID)
);

create table MPI_LINK (
                          PID number(19,0) not null,
                          PARTITION_DATE date,
                          PARTITION_ID number(10,0),
                          CREATED timestamp(6) not null,
                          EID_MATCH number(1,0),
                          GOLDEN_RESOURCE_PID number(19,0) not null,
                          NEW_PERSON number(1,0),
                          LINK_SOURCE number(10,0) not null,
                          MATCH_RESULT number(10,0) not null,
                          TARGET_TYPE varchar2(40 char),
                          PERSON_PID number(19,0) not null,
                          RULE_COUNT number(19,0),
                          SCORE float(53),
                          TARGET_PID number(19,0) not null,
                          UPDATED timestamp(6) not null,
                          VECTOR number(19,0),
                          VERSION varchar2(16 char) not null,
                          primary key (PID),
                          constraint IDX_EMPI_PERSON_TGT unique (PERSON_PID, TARGET_PID)
);

create table MPI_LINK_AUD (
                              PID number(19,0) not null,
                              REV number(19,0) not null,
                              REVTYPE number(3,0),
                              PARTITION_DATE date,
                              PARTITION_ID number(10,0),
                              CREATED timestamp(6),
                              EID_MATCH number(1,0),
                              GOLDEN_RESOURCE_PID number(19,0),
                              NEW_PERSON number(1,0),
                              LINK_SOURCE number(10,0),
                              MATCH_RESULT number(10,0),
                              TARGET_TYPE varchar2(40 char),
                              PERSON_PID number(19,0),
                              RULE_COUNT number(19,0),
                              SCORE float(53),
                              TARGET_PID number(19,0),
                              UPDATED timestamp(6),
                              VECTOR number(19,0),
                              VERSION varchar2(16 char),
                              primary key (REV, PID)
);

create table NPM_PACKAGE (
                             PID number(19,0) not null,
                             CUR_VERSION_ID varchar2(200 char),
                             PACKAGE_DESC varchar2(200 char),
                             PACKAGE_ID varchar2(200 char) not null,
                             UPDATED_TIME timestamp(6) not null,
                             primary key (PID),
                             constraint IDX_PACK_ID unique (PACKAGE_ID)
);

create table NPM_PACKAGE_VER (
                                 PID number(19,0) not null,
                                 CURRENT_VERSION number(1,0) not null,
                                 PKG_DESC varchar2(200 char),
                                 DESC_UPPER varchar2(200 char),
                                 FHIR_VERSION varchar2(10 char) not null,
                                 FHIR_VERSION_ID varchar2(20 char) not null,
                                 PACKAGE_ID varchar2(200 char) not null,
                                 PACKAGE_SIZE_BYTES number(19,0) not null,
                                 SAVED_TIME timestamp(6) not null,
                                 UPDATED_TIME timestamp(6) not null,
                                 VERSION_ID varchar2(200 char) not null,
                                 PACKAGE_PID number(19,0) not null,
                                 BINARY_RES_ID number(19,0) not null,
                                 primary key (PID),
                                 constraint IDX_PACKVER unique (PACKAGE_ID, VERSION_ID)
);

create table NPM_PACKAGE_VER_RES (
                                     PID number(19,0) not null,
                                     CANONICAL_URL varchar2(200 char),
                                     CANONICAL_VERSION varchar2(200 char),
                                     FILE_DIR varchar2(200 char),
                                     FHIR_VERSION varchar2(10 char) not null,
                                     FHIR_VERSION_ID varchar2(20 char) not null,
                                     FILE_NAME varchar2(200 char),
                                     RES_SIZE_BYTES number(19,0) not null,
                                     RES_TYPE varchar2(40 char) not null,
                                     UPDATED_TIME timestamp(6) not null,
                                     PACKVER_PID number(19,0) not null,
                                     BINARY_RES_ID number(19,0) not null,
                                     primary key (PID)
);

create table TRM_CODESYSTEM (
                                PID number(19,0) not null,
                                CODE_SYSTEM_URI varchar2(200 char) not null,
                                CURRENT_VERSION_PID number(19,0),
                                CS_NAME varchar2(200 char),
                                RES_ID number(19,0),
                                primary key (PID),
                                constraint IDX_CS_CODESYSTEM unique (CODE_SYSTEM_URI)
);

create table TRM_CODESYSTEM_VER (
                                    PID number(19,0) not null,
                                    CS_DISPLAY varchar2(200 char),
                                    CODESYSTEM_PID number(19,0),
                                    CS_VERSION_ID varchar2(200 char),
                                    RES_ID number(19,0) not null,
                                    primary key (PID),
                                    constraint IDX_CODESYSTEM_AND_VER unique (CODESYSTEM_PID, CS_VERSION_ID)
);

create table TRM_CONCEPT (
                             PID number(19,0) not null,
                             CODEVAL varchar2(500 char) not null,
                             CODESYSTEM_PID number(19,0) not null,
                             DISPLAY varchar2(400 char),
                             INDEX_STATUS number(19,0),
                             PARENT_PIDS clob,
                             PARENT_PIDS_VC clob,
                             CODE_SEQUENCE number(10,0),
                             CONCEPT_UPDATED timestamp(6),
                             primary key (PID),
                             constraint IDX_CONCEPT_CS_CODE unique (CODESYSTEM_PID, CODEVAL)
);

create table TRM_CONCEPT_DESIG (
                                   PID number(19,0) not null,
                                   LANG varchar2(500 char),
                                   USE_CODE varchar2(500 char),
                                   USE_DISPLAY varchar2(500 char),
                                   USE_SYSTEM varchar2(500 char),
                                   VAL varchar2(2000 char),
                                   VAL_VC clob,
                                   CS_VER_PID number(19,0),
                                   CONCEPT_PID number(19,0),
                                   primary key (PID)
);

create table TRM_CONCEPT_MAP (
                                 PID number(19,0) not null,
                                 RES_ID number(19,0),
                                 SOURCE_URL varchar2(200 char),
                                 TARGET_URL varchar2(200 char),
                                 URL varchar2(200 char) not null,
                                 VER varchar2(200 char),
                                 primary key (PID),
                                 constraint IDX_CONCEPT_MAP_URL unique (URL, VER)
);

create table TRM_CONCEPT_MAP_GROUP (
                                       PID number(19,0) not null,
                                       CONCEPT_MAP_URL varchar2(200 char),
                                       SOURCE_URL varchar2(200 char) not null,
                                       SOURCE_VS varchar2(200 char),
                                       SOURCE_VERSION varchar2(200 char),
                                       TARGET_URL varchar2(200 char) not null,
                                       TARGET_VS varchar2(200 char),
                                       TARGET_VERSION varchar2(200 char),
                                       CONCEPT_MAP_PID number(19,0) not null,
                                       primary key (PID)
);

create table TRM_CONCEPT_MAP_GRP_ELEMENT (
                                             PID number(19,0) not null,
                                             SOURCE_CODE varchar2(500 char) not null,
                                             CONCEPT_MAP_URL varchar2(200 char),
                                             SOURCE_DISPLAY varchar2(500 char),
                                             SYSTEM_URL varchar2(200 char),
                                             SYSTEM_VERSION varchar2(200 char),
                                             VALUESET_URL varchar2(200 char),
                                             CONCEPT_MAP_GROUP_PID number(19,0) not null,
                                             primary key (PID)
);

create table TRM_CONCEPT_MAP_GRP_ELM_TGT (
                                             PID number(19,0) not null,
                                             TARGET_CODE varchar2(500 char),
                                             CONCEPT_MAP_URL varchar2(200 char),
                                             TARGET_DISPLAY varchar2(500 char),
                                             TARGET_EQUIVALENCE varchar2(50 char),
                                             SYSTEM_URL varchar2(200 char),
                                             SYSTEM_VERSION varchar2(200 char),
                                             VALUESET_URL varchar2(200 char),
                                             CONCEPT_MAP_GRP_ELM_PID number(19,0) not null,
                                             primary key (PID)
);

create table TRM_CONCEPT_PC_LINK (
                                     PID number(19,0) not null,
                                     CHILD_PID number(19,0),
                                     CODESYSTEM_PID number(19,0) not null,
                                     PARENT_PID number(19,0),
                                     REL_TYPE number(10,0),
                                     primary key (PID)
);

create table TRM_CONCEPT_PROPERTY (
                                      PID number(19,0) not null,
                                      PROP_CODESYSTEM varchar2(500 char),
                                      PROP_DISPLAY varchar2(500 char),
                                      PROP_KEY varchar2(500 char) not null,
                                      PROP_TYPE number(10,0) not null,
                                      PROP_VAL varchar2(500 char),
                                      PROP_VAL_BIN blob,
                                      PROP_VAL_LOB blob,
                                      CS_VER_PID number(19,0),
                                      CONCEPT_PID number(19,0),
                                      primary key (PID)
);

create table TRM_VALUESET (
                              PID number(19,0) not null,
                              EXPANSION_STATUS varchar2(50 char) not null,
                              EXPANDED_AT timestamp(6),
                              VSNAME varchar2(200 char),
                              RES_ID number(19,0),
                              TOTAL_CONCEPT_DESIGNATIONS number(19,0) default 0 not null,
                              TOTAL_CONCEPTS number(19,0) default 0 not null,
                              URL varchar2(200 char) not null,
                              VER varchar2(200 char),
                              primary key (PID),
                              constraint IDX_VALUESET_URL unique (URL, VER)
);

create table TRM_VALUESET_C_DESIGNATION (
                                            PID number(19,0) not null,
                                            VALUESET_CONCEPT_PID number(19,0) not null,
                                            LANG varchar2(500 char),
                                            USE_CODE varchar2(500 char),
                                            USE_DISPLAY varchar2(500 char),
                                            USE_SYSTEM varchar2(500 char),
                                            VAL varchar2(2000 char) not null,
                                            VALUESET_PID number(19,0) not null,
                                            primary key (PID)
);

create table TRM_VALUESET_CONCEPT (
                                      PID number(19,0) not null,
                                      CODEVAL varchar2(500 char) not null,
                                      DISPLAY varchar2(400 char),
                                      INDEX_STATUS number(19,0),
                                      VALUESET_ORDER number(10,0) not null,
                                      SOURCE_DIRECT_PARENT_PIDS clob,
                                      SOURCE_DIRECT_PARENT_PIDS_VC clob,
                                      SOURCE_PID number(19,0),
                                      SYSTEM_URL varchar2(200 char) not null,
                                      SYSTEM_VER varchar2(200 char),
                                      VALUESET_PID number(19,0) not null,
                                      primary key (PID),
                                      constraint IDX_VS_CONCEPT_CSCD unique (VALUESET_PID, SYSTEM_URL, CODEVAL),
                                      constraint IDX_VS_CONCEPT_ORDER unique (VALUESET_PID, VALUESET_ORDER)
);

create index IDX_BT2JI_CT
    on BT2_JOB_INSTANCE (CREATE_TIME);

create index IDX_BT2WC_II_SEQ
    on BT2_WORK_CHUNK (INSTANCE_ID, SEQ);

create index IDX_BT2WC_II_SI_S_SEQ_ID
    on BT2_WORK_CHUNK (INSTANCE_ID, TGT_STEP_ID, STAT, SEQ, ID);

create index IDX_BLKEX_EXPTIME
    on HFJ_BLK_EXPORT_JOB (EXP_TIME);

create index IDX_BLKIM_JOBFILE_JOBID
    on HFJ_BLK_IMPORT_JOBFILE (JOB_PID);

create index IDX_RESHISTTAG_RESID
    on HFJ_HISTORY_TAG (RES_ID);

create index IDX_IDXCMBTOKNU_STR
    on HFJ_IDX_CMB_TOK_NU (IDX_STRING);

create index IDX_IDXCMBTOKNU_HASHC
    on HFJ_IDX_CMB_TOK_NU (HASH_COMPLETE, RES_ID, PARTITION_ID);

create index IDX_IDXCMBTOKNU_RES
    on HFJ_IDX_CMB_TOK_NU (RES_ID);

create index IDX_IDXCMPSTRUNIQ_RESOURCE
    on HFJ_IDX_CMP_STRING_UNIQ (RES_ID);

create index IDX_RL_SRC
    on HFJ_RES_LINK (SRC_RESOURCE_ID);

create index IDX_RL_TGT_v2
    on HFJ_RES_LINK (TARGET_RESOURCE_ID, SRC_PATH, SRC_RESOURCE_ID, TARGET_RESOURCE_TYPE, PARTITION_ID);

create index IDX_RESPARMPRESENT_RESID
    on HFJ_RES_PARAM_PRESENT (RES_ID);

create index IDX_RESPARMPRESENT_HASHPRES
    on HFJ_RES_PARAM_PRESENT (HASH_PRESENCE);

create index IDX_RESSEARCHURL_RES
    on HFJ_RES_SEARCH_URL (RES_ID);

create index IDX_RESSEARCHURL_TIME
    on HFJ_RES_SEARCH_URL (CREATED_TIME);

create index IDX_RES_TAG_RES_TAG
    on HFJ_RES_TAG (RES_ID, TAG_ID, PARTITION_ID);

create index IDX_RES_TAG_TAG_RES
    on HFJ_RES_TAG (TAG_ID, RES_ID, PARTITION_ID);

create index IDX_RESVER_TYPE_DATE
    on HFJ_RES_VER (RES_TYPE, RES_UPDATED, RES_ID);

create index IDX_RESVER_ID_DATE
    on HFJ_RES_VER (RES_ID, RES_UPDATED);

create index IDX_RESVER_DATE
    on HFJ_RES_VER (RES_UPDATED, RES_ID);

create index IDX_RESVERPROV_SOURCEURI
    on HFJ_RES_VER_PROV (SOURCE_URI);

create index IDX_RESVERPROV_REQUESTID
    on HFJ_RES_VER_PROV (REQUEST_ID);

create index IDX_RESVERPROV_RES_PID
    on HFJ_RES_VER_PROV (RES_PID);

create index IDX_RES_DATE
    on HFJ_RESOURCE (RES_UPDATED);

create index IDX_RES_FHIR_ID
    on HFJ_RESOURCE (FHIR_ID);

create index IDX_RES_TYPE_DEL_UPDATED
    on HFJ_RESOURCE (RES_TYPE, RES_DELETED_AT, RES_UPDATED, PARTITION_ID, RES_ID);

create index IDX_RES_RESID_UPDATED
    on HFJ_RESOURCE (RES_ID, RES_UPDATED, PARTITION_ID);

create index IDX_SEARCH_RESTYPE_HASHS
    on HFJ_SEARCH (RESOURCE_TYPE, SEARCH_QUERY_STRING_HASH, CREATED);

create index IDX_SEARCH_CREATED
    on HFJ_SEARCH (CREATED);

create index FK_SEARCHINC_SEARCH
    on HFJ_SEARCH_INCLUDE (SEARCH_PID);

create index IDX_SP_COORDS_HASH_V2
    on HFJ_SPIDX_COORDS (HASH_IDENTITY, SP_LATITUDE, SP_LONGITUDE, RES_ID, PARTITION_ID);

create index IDX_SP_COORDS_UPDATED
    on HFJ_SPIDX_COORDS (SP_UPDATED);

create index IDX_SP_COORDS_RESID
    on HFJ_SPIDX_COORDS (RES_ID);

create index IDX_SP_DATE_HASH_V2
    on HFJ_SPIDX_DATE (HASH_IDENTITY, SP_VALUE_LOW, SP_VALUE_HIGH, RES_ID, PARTITION_ID);

create index IDX_SP_DATE_HASH_HIGH_V2
    on HFJ_SPIDX_DATE (HASH_IDENTITY, SP_VALUE_HIGH, RES_ID, PARTITION_ID);

create index IDX_SP_DATE_ORD_HASH_V2
    on HFJ_SPIDX_DATE (HASH_IDENTITY, SP_VALUE_LOW_DATE_ORDINAL, SP_VALUE_HIGH_DATE_ORDINAL, RES_ID, PARTITION_ID);

create index IDX_SP_DATE_ORD_HASH_HIGH_V2
    on HFJ_SPIDX_DATE (HASH_IDENTITY, SP_VALUE_HIGH_DATE_ORDINAL, RES_ID, PARTITION_ID);

create index IDX_SP_DATE_RESID_V2
    on HFJ_SPIDX_DATE (RES_ID, HASH_IDENTITY, SP_VALUE_LOW, SP_VALUE_HIGH, SP_VALUE_LOW_DATE_ORDINAL, SP_VALUE_HIGH_DATE_ORDINAL, PARTITION_ID);

create index IDX_SP_NUMBER_HASH_VAL_V2
    on HFJ_SPIDX_NUMBER (HASH_IDENTITY, SP_VALUE, RES_ID, PARTITION_ID);

create index IDX_SP_NUMBER_RESID_V2
    on HFJ_SPIDX_NUMBER (RES_ID, HASH_IDENTITY, SP_VALUE, PARTITION_ID);

create index IDX_SP_QUANTITY_HASH_V2
    on HFJ_SPIDX_QUANTITY (HASH_IDENTITY, SP_VALUE, RES_ID, PARTITION_ID);

create index IDX_SP_QUANTITY_HASH_UN_V2
    on HFJ_SPIDX_QUANTITY (HASH_IDENTITY_AND_UNITS, SP_VALUE, RES_ID, PARTITION_ID);

create index IDX_SP_QUANTITY_HASH_SYSUN_V2
    on HFJ_SPIDX_QUANTITY (HASH_IDENTITY_SYS_UNITS, SP_VALUE, RES_ID, PARTITION_ID);

create index IDX_SP_QUANTITY_RESID_V2
    on HFJ_SPIDX_QUANTITY (RES_ID, HASH_IDENTITY, HASH_IDENTITY_SYS_UNITS, HASH_IDENTITY_AND_UNITS, SP_VALUE, PARTITION_ID);

create index IDX_SP_QNTY_NRML_HASH_V2
    on HFJ_SPIDX_QUANTITY_NRML (HASH_IDENTITY, SP_VALUE, RES_ID, PARTITION_ID);

create index IDX_SP_QNTY_NRML_HASH_UN_V2
    on HFJ_SPIDX_QUANTITY_NRML (HASH_IDENTITY_AND_UNITS, SP_VALUE, RES_ID, PARTITION_ID);

create index IDX_SP_QNTY_NRML_HASH_SYSUN_V2
    on HFJ_SPIDX_QUANTITY_NRML (HASH_IDENTITY_SYS_UNITS, SP_VALUE, RES_ID, PARTITION_ID);

create index IDX_SP_QNTY_NRML_RESID_V2
    on HFJ_SPIDX_QUANTITY_NRML (RES_ID, HASH_IDENTITY, HASH_IDENTITY_SYS_UNITS, HASH_IDENTITY_AND_UNITS, SP_VALUE, PARTITION_ID);

create index IDX_SP_STRING_HASH_IDENT_V2
    on HFJ_SPIDX_STRING (HASH_IDENTITY, RES_ID, PARTITION_ID);

create index IDX_SP_STRING_HASH_NRM_V2
    on HFJ_SPIDX_STRING (HASH_NORM_PREFIX, SP_VALUE_NORMALIZED, RES_ID, PARTITION_ID);

create index IDX_SP_STRING_HASH_EXCT_V2
    on HFJ_SPIDX_STRING (HASH_EXACT, RES_ID, PARTITION_ID);

create index IDX_SP_STRING_RESID_V2
    on HFJ_SPIDX_STRING (RES_ID, HASH_NORM_PREFIX, PARTITION_ID);

create index IDX_SP_TOKEN_HASH_V2
    on HFJ_SPIDX_TOKEN (HASH_IDENTITY, SP_SYSTEM, SP_VALUE, RES_ID, PARTITION_ID);

create index IDX_SP_TOKEN_HASH_S_V2
    on HFJ_SPIDX_TOKEN (HASH_SYS, RES_ID, PARTITION_ID);

create index IDX_SP_TOKEN_HASH_SV_V2
    on HFJ_SPIDX_TOKEN (HASH_SYS_AND_VALUE, RES_ID, PARTITION_ID);

create index IDX_SP_TOKEN_HASH_V_V2
    on HFJ_SPIDX_TOKEN (HASH_VALUE, RES_ID, PARTITION_ID);

create index IDX_SP_TOKEN_RESID_V2
    on HFJ_SPIDX_TOKEN (RES_ID, HASH_SYS_AND_VALUE, HASH_VALUE, HASH_SYS, HASH_IDENTITY, PARTITION_ID);

create index IDX_SP_URI_HASH_URI_V2
    on HFJ_SPIDX_URI (HASH_URI, RES_ID, PARTITION_ID);

create index IDX_SP_URI_HASH_IDENTITY_V2
    on HFJ_SPIDX_URI (HASH_IDENTITY, SP_URI, RES_ID, PARTITION_ID);

create index IDX_SP_URI_COORDS
    on HFJ_SPIDX_URI (RES_ID);

create index IDX_TAG_DEF_TP_CD_SYS
    on HFJ_TAG_DEF (TAG_TYPE, TAG_CODE, TAG_SYSTEM, TAG_ID, TAG_VERSION, TAG_USER_SELECTED);

create index IDX_EMPI_MATCH_TGT_VER
    on MPI_LINK (MATCH_RESULT, TARGET_PID, VERSION);

create index IDX_EMPI_GR_TGT
    on MPI_LINK (GOLDEN_RESOURCE_PID, TARGET_PID);

create index FK_EMPI_LINK_TARGET
    on MPI_LINK (TARGET_PID);

create index IDX_EMPI_TGT_MR_LS
    on MPI_LINK (TARGET_TYPE, MATCH_RESULT, LINK_SOURCE);

create index IDX_EMPI_TGT_MR_SCORE
    on MPI_LINK (TARGET_TYPE, MATCH_RESULT, SCORE);

create index FK_NPM_PKV_PKG
    on NPM_PACKAGE_VER (PACKAGE_PID);

create index FK_NPM_PKV_RESID
    on NPM_PACKAGE_VER (BINARY_RES_ID);

create index IDX_PACKVERRES_URL
    on NPM_PACKAGE_VER_RES (CANONICAL_URL);

create index FK_NPM_PACKVERRES_PACKVER
    on NPM_PACKAGE_VER_RES (PACKVER_PID);

create index FK_NPM_PKVR_RESID
    on NPM_PACKAGE_VER_RES (BINARY_RES_ID);

create index FK_TRMCODESYSTEM_RES
    on TRM_CODESYSTEM (RES_ID);

create index FK_TRMCODESYSTEM_CURVER
    on TRM_CODESYSTEM (CURRENT_VERSION_PID);

create index FK_CODESYSVER_RES_ID
    on TRM_CODESYSTEM_VER (RES_ID);

create index FK_CODESYSVER_CS_ID
    on TRM_CODESYSTEM_VER (CODESYSTEM_PID);

create index IDX_CONCEPT_INDEXSTATUS
    on TRM_CONCEPT (INDEX_STATUS);

create index IDX_CONCEPT_UPDATED
    on TRM_CONCEPT (CONCEPT_UPDATED);

create index FK_CONCEPTDESIG_CONCEPT
    on TRM_CONCEPT_DESIG (CONCEPT_PID);

create index FK_CONCEPTDESIG_CSV
    on TRM_CONCEPT_DESIG (CS_VER_PID);

create index FK_TRMCONCEPTMAP_RES
    on TRM_CONCEPT_MAP (RES_ID);

create index FK_TCMGROUP_CONCEPTMAP
    on TRM_CONCEPT_MAP_GROUP (CONCEPT_MAP_PID);

create index IDX_CNCPT_MAP_GRP_CD
    on TRM_CONCEPT_MAP_GRP_ELEMENT (SOURCE_CODE);

create index FK_TCMGELEMENT_GROUP
    on TRM_CONCEPT_MAP_GRP_ELEMENT (CONCEPT_MAP_GROUP_PID);

create index IDX_CNCPT_MP_GRP_ELM_TGT_CD
    on TRM_CONCEPT_MAP_GRP_ELM_TGT (TARGET_CODE);

create index FK_TCMGETARGET_ELEMENT
    on TRM_CONCEPT_MAP_GRP_ELM_TGT (CONCEPT_MAP_GRP_ELM_PID);

create index FK_TERM_CONCEPTPC_CHILD
    on TRM_CONCEPT_PC_LINK (CHILD_PID);

create index FK_TERM_CONCEPTPC_PARENT
    on TRM_CONCEPT_PC_LINK (PARENT_PID);

create index FK_TERM_CONCEPTPC_CS
    on TRM_CONCEPT_PC_LINK (CODESYSTEM_PID);

create index FK_CONCEPTPROP_CONCEPT
    on TRM_CONCEPT_PROPERTY (CONCEPT_PID);

create index FK_CONCEPTPROP_CSV
    on TRM_CONCEPT_PROPERTY (CS_VER_PID);

create index FK_TRMVALUESET_RES
    on TRM_VALUESET (RES_ID);

create index FK_TRM_VALUESET_CONCEPT_PID
    on TRM_VALUESET_C_DESIGNATION (VALUESET_CONCEPT_PID);

create index FK_TRM_VSCD_VS_PID
    on TRM_VALUESET_C_DESIGNATION (VALUESET_PID);

alter table BT2_WORK_CHUNK
    add constraint FK_BT2WC_INSTANCE
        foreign key (INSTANCE_ID)
            references BT2_JOB_INSTANCE;

alter table HFJ_BLK_EXPORT_COLFILE
    add constraint FK_BLKEXCOLFILE_COLLECT
        foreign key (COLLECTION_PID)
            references HFJ_BLK_EXPORT_COLLECTION;

alter table HFJ_BLK_EXPORT_COLLECTION
    add constraint FK_BLKEXCOL_JOB
        foreign key (JOB_PID)
            references HFJ_BLK_EXPORT_JOB;

alter table HFJ_BLK_IMPORT_JOBFILE
    add constraint FK_BLKIMJOBFILE_JOB
        foreign key (JOB_PID)
            references HFJ_BLK_IMPORT_JOB;

alter table HFJ_HISTORY_TAG
    add constraint FKtderym7awj6q8iq5c51xv4ndw
        foreign key (TAG_ID)
            references HFJ_TAG_DEF;

alter table HFJ_HISTORY_TAG
    add constraint FK_HISTORYTAG_HISTORY
        foreign key (RES_VER_PID)
            references HFJ_RES_VER;

alter table HFJ_IDX_CMB_TOK_NU
    add constraint FK_IDXCMBTOKNU_RES_ID
        foreign key (RES_ID)
            references HFJ_RESOURCE;

alter table HFJ_IDX_CMP_STRING_UNIQ
    add constraint FK_IDXCMPSTRUNIQ_RES_ID
        foreign key (RES_ID)
            references HFJ_RESOURCE;

alter table HFJ_RES_LINK
    add constraint FK_RESLINK_SOURCE
        foreign key (SRC_RESOURCE_ID)
            references HFJ_RESOURCE;

alter table HFJ_RES_LINK
    add constraint FK_RESLINK_TARGET
        foreign key (TARGET_RESOURCE_ID)
            references HFJ_RESOURCE;

alter table HFJ_RES_PARAM_PRESENT
    add constraint FK_RESPARMPRES_RESID
        foreign key (RES_ID)
            references HFJ_RESOURCE;

alter table HFJ_RES_SEARCH_URL
    add constraint FK_RES_SEARCH_URL_RESOURCE
        foreign key (RES_ID)
            references HFJ_RESOURCE;

alter table HFJ_RES_TAG
    add constraint FKbfcjbaftmiwr3rxkwsy23vneo
        foreign key (TAG_ID)
            references HFJ_TAG_DEF;

alter table HFJ_RES_TAG
    add constraint FK_RESTAG_RESOURCE
        foreign key (RES_ID)
            references HFJ_RESOURCE;

alter table HFJ_RES_VER
    add constraint FK_RESOURCE_HISTORY_RESOURCE
        foreign key (RES_ID)
            references HFJ_RESOURCE;

alter table HFJ_RES_VER_PROV
    add constraint FK_RESVERPROV_RES_PID
        foreign key (RES_PID)
            references HFJ_RESOURCE;

alter table HFJ_RES_VER_PROV
    add constraint FK_RESVERPROV_RESVER_PID
        foreign key (RES_VER_PID)
            references HFJ_RES_VER;

alter table HFJ_SEARCH_INCLUDE
    add constraint FK_SEARCHINC_SEARCH
        foreign key (SEARCH_PID)
            references HFJ_SEARCH;

alter table HFJ_SPIDX_COORDS
    add constraint FKC97MPK37OKWU8QVTCEG2NH9VN
        foreign key (RES_ID)
            references HFJ_RESOURCE;

alter table HFJ_SPIDX_DATE
    add constraint FK_SP_DATE_RES
        foreign key (RES_ID)
            references HFJ_RESOURCE;

alter table HFJ_SPIDX_NUMBER
    add constraint FK_SP_NUMBER_RES
        foreign key (RES_ID)
            references HFJ_RESOURCE;

alter table HFJ_SPIDX_QUANTITY
    add constraint FK_SP_QUANTITY_RES
        foreign key (RES_ID)
            references HFJ_RESOURCE;

alter table HFJ_SPIDX_QUANTITY_NRML
    add constraint FK_SP_QUANTITYNM_RES
        foreign key (RES_ID)
            references HFJ_RESOURCE;

alter table HFJ_SPIDX_STRING
    add constraint FK_SPIDXSTR_RESOURCE
        foreign key (RES_ID)
            references HFJ_RESOURCE;

alter table HFJ_SPIDX_TOKEN
    add constraint FK_SP_TOKEN_RES
        foreign key (RES_ID)
            references HFJ_RESOURCE;

alter table HFJ_SPIDX_URI
    add constraint FKGXSREUTYMMFJUWDSWV3Y887DO
        foreign key (RES_ID)
            references HFJ_RESOURCE;

alter table HFJ_SUBSCRIPTION_STATS
    add constraint FK_SUBSC_RESOURCE_ID
        foreign key (RES_ID)
            references HFJ_RESOURCE;

alter table MPI_LINK
    add constraint FK_EMPI_LINK_GOLDEN_RESOURCE
        foreign key (GOLDEN_RESOURCE_PID)
            references HFJ_RESOURCE;

alter table MPI_LINK
    add constraint FK_EMPI_LINK_PERSON
        foreign key (PERSON_PID)
            references HFJ_RESOURCE;

alter table MPI_LINK
    add constraint FK_EMPI_LINK_TARGET
        foreign key (TARGET_PID)
            references HFJ_RESOURCE;

alter table MPI_LINK_AUD
    add constraint FKaow7nxncloec419ars0fpp58m
        foreign key (REV)
            references HFJ_REVINFO;

alter table NPM_PACKAGE_VER
    add constraint FK_NPM_PKV_PKG
        foreign key (PACKAGE_PID)
            references NPM_PACKAGE;

alter table NPM_PACKAGE_VER
    add constraint FK_NPM_PKV_RESID
        foreign key (BINARY_RES_ID)
            references HFJ_RESOURCE;

alter table NPM_PACKAGE_VER_RES
    add constraint FK_NPM_PACKVERRES_PACKVER
        foreign key (PACKVER_PID)
            references NPM_PACKAGE_VER;

alter table NPM_PACKAGE_VER_RES
    add constraint FK_NPM_PKVR_RESID
        foreign key (BINARY_RES_ID)
            references HFJ_RESOURCE;

alter table TRM_CODESYSTEM
    add constraint FK_TRMCODESYSTEM_CURVER
        foreign key (CURRENT_VERSION_PID)
            references TRM_CODESYSTEM_VER;

alter table TRM_CODESYSTEM
    add constraint FK_TRMCODESYSTEM_RES
        foreign key (RES_ID)
            references HFJ_RESOURCE;

alter table TRM_CODESYSTEM_VER
    add constraint FK_CODESYSVER_CS_ID
        foreign key (CODESYSTEM_PID)
            references TRM_CODESYSTEM;

alter table TRM_CODESYSTEM_VER
    add constraint FK_CODESYSVER_RES_ID
        foreign key (RES_ID)
            references HFJ_RESOURCE;

alter table TRM_CONCEPT
    add constraint FK_CONCEPT_PID_CS_PID
        foreign key (CODESYSTEM_PID)
            references TRM_CODESYSTEM_VER;

alter table TRM_CONCEPT_DESIG
    add constraint FK_CONCEPTDESIG_CSV
        foreign key (CS_VER_PID)
            references TRM_CODESYSTEM_VER;

alter table TRM_CONCEPT_DESIG
    add constraint FK_CONCEPTDESIG_CONCEPT
        foreign key (CONCEPT_PID)
            references TRM_CONCEPT;

alter table TRM_CONCEPT_MAP
    add constraint FK_TRMCONCEPTMAP_RES
        foreign key (RES_ID)
            references HFJ_RESOURCE;

alter table TRM_CONCEPT_MAP_GROUP
    add constraint FK_TCMGROUP_CONCEPTMAP
        foreign key (CONCEPT_MAP_PID)
            references TRM_CONCEPT_MAP;

alter table TRM_CONCEPT_MAP_GRP_ELEMENT
    add constraint FK_TCMGELEMENT_GROUP
        foreign key (CONCEPT_MAP_GROUP_PID)
            references TRM_CONCEPT_MAP_GROUP;

alter table TRM_CONCEPT_MAP_GRP_ELM_TGT
    add constraint FK_TCMGETARGET_ELEMENT
        foreign key (CONCEPT_MAP_GRP_ELM_PID)
            references TRM_CONCEPT_MAP_GRP_ELEMENT;

alter table TRM_CONCEPT_PC_LINK
    add constraint FK_TERM_CONCEPTPC_CHILD
        foreign key (CHILD_PID)
            references TRM_CONCEPT;

alter table TRM_CONCEPT_PC_LINK
    add constraint FK_TERM_CONCEPTPC_CS
        foreign key (CODESYSTEM_PID)
            references TRM_CODESYSTEM_VER;

alter table TRM_CONCEPT_PC_LINK
    add constraint FK_TERM_CONCEPTPC_PARENT
        foreign key (PARENT_PID)
            references TRM_CONCEPT;

alter table TRM_CONCEPT_PROPERTY
    add constraint FK_CONCEPTPROP_CSV
        foreign key (CS_VER_PID)
            references TRM_CODESYSTEM_VER;

alter table TRM_CONCEPT_PROPERTY
    add constraint FK_CONCEPTPROP_CONCEPT
        foreign key (CONCEPT_PID)
            references TRM_CONCEPT;

alter table TRM_VALUESET
    add constraint FK_TRMVALUESET_RES
        foreign key (RES_ID)
            references HFJ_RESOURCE;

alter table TRM_VALUESET_C_DESIGNATION
    add constraint FK_TRM_VALUESET_CONCEPT_PID
        foreign key (VALUESET_CONCEPT_PID)
            references TRM_VALUESET_CONCEPT;

alter table TRM_VALUESET_C_DESIGNATION
    add constraint FK_TRM_VSCD_VS_PID
        foreign key (VALUESET_PID)
            references TRM_VALUESET;

alter table TRM_VALUESET_CONCEPT
    add constraint FK_TRM_VALUESET_PID
        foreign key (VALUESET_PID)
            references TRM_VALUESET;
