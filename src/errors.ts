export type AppErrorCode =
  | 'INVALID_ID'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'NOT_STARTABLE'
  | 'NOT_CANCELLABLE'
  | 'NOT_OPEN'
  | 'ROUND_ENDED'
  | 'BID_NOT_ACTIVE'
  | 'INSUFFICIENT_FUNDS'
  | 'INVARIANT_VIOLATION';

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(opts: {
    code: AppErrorCode;
    message: string;
    status: number;
    details?: Record<string, unknown>;
  }) {
    super(opts.message);
    this.code = opts.code;
    this.status = opts.status;
    this.details = opts.details;
    this.name = 'AppError';
  }
}

export function appError(
  code: AppErrorCode,
  message: string,
  status: number,
  details?: Record<string, unknown>
): AppError {
  return new AppError({ code, message, status, ...(details ? { details } : {}) });
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
