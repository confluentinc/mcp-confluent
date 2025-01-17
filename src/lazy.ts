export class Lazy<T> {
  private instance: T | undefined;
  private supplier: () => T;
  private closeHandler?: (instance: T) => void;
  constructor(supplier: () => T, closeHandler?: (instance: T) => void) {
    this.supplier = supplier;
    this.closeHandler = closeHandler;
  }

  get(): T {
    if (!this.instance) {
      this.instance = this.supplier();
    }
    return this.instance;
  }

  close(): void {
    if (this.instance && this.closeHandler) {
      this.closeHandler(this.instance);
      this.instance = undefined;
    }
  }
}

export class AsyncLazy<T> {
  private instance: T | undefined;
  private supplier: () => Promise<T>;
  private closeHandler?: (instance: T) => Promise<void>;

  constructor(
    supplier: () => Promise<T>,
    closeHandler?: (instance: T) => Promise<void>,
  ) {
    this.supplier = supplier;
    this.closeHandler = closeHandler;
  }

  async get(): Promise<T> {
    if (!this.instance) {
      this.instance = await this.supplier();
    }
    return this.instance;
  }

  async close(): Promise<void> {
    if (this.instance && this.closeHandler) {
      await this.closeHandler(this.instance);
      this.instance = undefined;
    }
  }
}
