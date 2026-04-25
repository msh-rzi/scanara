export class ScannerRpcError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ScannerRpcError';
  }
}

export class UnknownTokenError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UnknownTokenError';
  }
}
