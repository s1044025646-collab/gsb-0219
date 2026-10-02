/** 统一错误码与业务异常 */
export const ErrorCodes = {
  INVALID_PARAM: 'INVALID_PARAM',
  BOOK_NOT_FOUND: 'BOOK_NOT_FOUND',
  CHECK_NOT_FOUND: 'CHECK_NOT_FOUND',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  ZIP_INVALID: 'ZIP_INVALID',
  CONTAINER_MISSING: 'CONTAINER_MISSING',
  CONTAINER_PARSE_ERROR: 'CONTAINER_PARSE_ERROR',
  OPF_NOT_FOUND: 'OPF_NOT_FOUND',
  OPF_PARSE_ERROR: 'OPF_PARSE_ERROR',
  PATH_TRAVERSAL: 'PATH_TRAVERSAL',
  XML_PARSE_ERROR: 'XML_PARSE_ERROR',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = keyof typeof ErrorCodes;

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public httpStatus = 400,
    public detail?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
