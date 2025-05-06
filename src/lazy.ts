/**
 * A class that implements lazy loading for synchronous values.
 * It defers the initialization of a value until it's first requested.
 * @template T The type of value to be lazily loaded
 */

import { logger } from "@src/logger.js";

export class Lazy<T> {
  /** The cached instance of the lazily loaded value */
  private instance: T | undefined;

  /** A function that produces the value to be lazily loaded */
  private readonly supplier: () => T;

  /** Optional handler to clean up the instance when closed */
  private readonly closeHandler?: (instance: T) => void;

  /**
   * Creates a new Lazy instance
   * @param supplier A function that creates the lazy-loaded value
   * @param closeHandler Optional function to clean up the instance when closed
   */
  constructor(supplier: () => T, closeHandler?: (instance: T) => void) {
    this.supplier = supplier;
    this.closeHandler = closeHandler;
  }

  /**
   * Retrieves the lazy-loaded value, initializing it if necessary
   * @returns The lazy-loaded value
   * @throws If the supplier function fails to initialize the value
   */
  get(): T {
    try {
      this.instance = this.supplier();
      logger.debug(
        `Lazy instance created with type ${this.instance?.constructor.name || typeof this.instance}`,
      );
    } catch (error) {
      throw new Error(`Failed to initialize lazy instance: ${error}`);
    }
    return this.instance!;
  }

  /**
   * Closes and cleans up the lazy-loaded instance if it exists.
   * If a closeHandler was provided, it will be called with the instance.
   * The instance is set to undefined after cleanup.
   */
  close(): void {
    if (this.instance) {
      if (this.closeHandler) {
        logger.debug(
          `Initiating close handler for lazy instance of type ${typeof this.instance}`,
        );
        this.closeHandler(this.instance);
        logger.debug(`Lazy instance closed with type ${typeof this.instance}`);
      }
      this.instance = undefined;
    }
  }
}

/**
 * A class that implements lazy loading for asynchronous values.
 * It defers the initialization of a value until it's first requested.
 * @template T The type of value to be lazily loaded
 */
export class AsyncLazy<T> {
  /** The cached instance of the lazily loaded value */
  private instance: T | undefined;

  /** A function that produces the value to be lazily loaded */
  private readonly supplier: () => Promise<T>;

  /** Optional handler to clean up the instance when closed */
  private readonly closeHandler?: (instance: T) => Promise<void>;

  /** Tracks the ongoing initialization promise to prevent multiple simultaneous initializations */
  private initializationPromise: Promise<T> | null = null;

  /**
   * Creates a new AsyncLazy instance
   * @param supplier An async function that creates the lazy-loaded value
   * @param closeHandler Optional async function to clean up the instance when closed
   */
  constructor(
    supplier: () => Promise<T>,
    closeHandler?: (instance: T) => Promise<void>,
  ) {
    this.supplier = supplier;
    this.closeHandler = closeHandler;
  }

  /**
   * Retrieves the lazy-loaded value, initializing it if necessary
   * @returns A promise that resolves to the lazy-loaded value
   * @throws If the supplier function fails to initialize the value
   */
  async get(): Promise<T> {
    if (!this.instance) {
      if (!this.initializationPromise) {
        this.initializationPromise = this.supplier();
      }
      this.instance = await this.initializationPromise;
    }
    logger.debug(
      `Async Lazy instance created with type ${this.instance?.constructor.name || typeof this.instance}`,
    );
    return this.instance;
  }

  /**
   * Closes and cleans up the lazy-loaded instance if it exists
   * If a closeHandler was provided, it will be called with the instance
   * @returns A promise that resolves when the cleanup is complete
   */
  async close(): Promise<void> {
    if (this.instance) {
      if (this.closeHandler) {
        logger.debug(
          `Initiating close handler for lazy instance of type ${typeof this.instance}`,
        );
        await this.closeHandler(this.instance);
        logger.debug(`Lazy instance closed with type ${typeof this.instance}`);
      }
    }
  }
}
