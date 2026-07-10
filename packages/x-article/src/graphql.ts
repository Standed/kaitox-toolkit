/** Reject GraphQL application errors even when the HTTP request succeeded. */
export function assertGraphqlSuccess(operation: string, raw: any): void {
  if (Array.isArray(raw?.errors) && raw.errors.length > 0) {
    const message = raw.errors
      .map((error: any) => error?.message || JSON.stringify(error))
      .join('; ');
    throw new Error(`${operation} GraphQL 失败：${message}`);
  }
}
