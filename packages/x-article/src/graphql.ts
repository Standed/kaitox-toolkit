/** Reject GraphQL application errors even when the HTTP request succeeded. */
export function assertGraphqlSuccess(operation: string, raw: any): void {
  if (Array.isArray(raw?.errors) && raw.errors.length > 0) {
    const message = raw.errors
      .map((error: any) => error?.message || JSON.stringify(error))
      .join('; ');
    throw new Error(`${operation} GraphQL 失败：${message}`);
  }
}

/** Require the operation payload itself to confirm success, not only HTTP 200. */
export function assertGraphqlMutationSuccess(operation: string, raw: any, dataKey: string): void {
  assertGraphqlSuccess(operation, raw);
  const payload = raw?.data?.[dataKey];
  if (payload == null || payload.success !== true) {
    throw new Error(`${operation} 未确认成功：${JSON.stringify(payload)}`);
  }
}
