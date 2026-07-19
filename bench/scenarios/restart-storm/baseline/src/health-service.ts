export interface DatabaseHealth {
  isAvailable(): Promise<boolean>;
}

export interface ProcessState {
  running: boolean;
  started: boolean;
}

export class HealthService {
  constructor(
    private readonly database: DatabaseHealth,
    private readonly processState: ProcessState,
  ) {}

  async liveness(): Promise<boolean> {
    return this.processState.running;
  }

  async readiness(): Promise<boolean> {
    return this.processState.running;
  }

  async startup(): Promise<boolean> {
    return this.processState.running && this.processState.started;
  }
}
