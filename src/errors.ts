export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'INVALID_ZIP'
  | 'INVALID_XML'
  | 'PATH_TRAVERSAL'
  | 'CONTAINER_MISSING'
  | 'OPF_MISSING'
  | 'UNSUPPORTED'
  | 'INTERNAL';

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public httpStatus = 400,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function toErrorPayload(err: unknown): { code: ErrorCode; message: string; httpStatus: number } {
  if (err instanceof ApiError) {
    return { code: err.code, message: err.message, httpStatus: err.httpStatus };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'INTERNAL', message, httpStatus: 500 };
}
