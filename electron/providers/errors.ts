export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function normalizeProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }

  if (error instanceof Error) {
    return new ProviderError("PROVIDER_ERROR", error.message);
  }

  return new ProviderError("PROVIDER_ERROR", "Unknown provider error");
}

export function isRetryableTextChannelRejection(status: number | undefined): boolean {
  return status === 401 || status === 402 || status === 404 || status === 429;
}

export class ImageSubmissionError extends ProviderError {
  constructor(
    readonly outcome: "rejected" | "failed" | "unknown" | "blocked",
    code: string,
    message: string,
    status?: number
  ) {
    super(code, message, status);
  }
}
