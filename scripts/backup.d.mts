// Types for the parts of backup.mjs the dashboard's server uses (core/backup.ts).
export declare const TABLES: string[]
export declare function snapshotDb(src: string, dest: string): void
export declare function checkDb(file: string): {
  integrity: string
  counts: Record<string, number>
}
