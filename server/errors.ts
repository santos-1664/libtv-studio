export class HttpError extends Error {
  constructor(public status: number, message: string, public ambiguous = false) { super(message); }
}
export const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试';
