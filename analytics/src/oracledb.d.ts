// The slice of node-oracledb (thin mode) this project uses. Declared locally rather than adding @types/oracledb,
// a package beyond the set approved for M9.
declare module "oracledb" {
  export const OUT_FORMAT_OBJECT: number;

  export interface ExecuteOptions {
    outFormat?: number;
  }

  export interface Result<T> {
    rows?: T[];
    rowsAffected?: number;
  }

  export interface Connection {
    execute<T = unknown>(sql: string, binds?: Record<string, unknown>, options?: ExecuteOptions): Promise<Result<T>>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    close(): Promise<void>;
  }

  export function getConnection(config: { user: string; password: string; connectString: string }): Promise<Connection>;

  const oracledb: {
    OUT_FORMAT_OBJECT: number;
    getConnection: typeof getConnection;
  };
  export default oracledb;
}
