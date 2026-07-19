// source: health-service.d.ts
export interface DatabaseHealth {
  isAvailable(): Promise<boolean>;
}
export interface ProcessState {
  running: boolean;
  started: boolean;
}
export declare class HealthService {
  private readonly database;
  private readonly processState;
  constructor(database: DatabaseHealth, processState: ProcessState);
  liveness(): Promise<boolean>;
  readiness(): Promise<boolean>;
  startup(): Promise<boolean>;
}
