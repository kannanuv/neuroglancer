/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {AvailableCapacity, CHUNK_MANAGER_RPC_ID, CHUNK_QUEUE_MANAGER_RPC_ID, ChunkSourceParametersConstructor, ChunkState} from 'neuroglancer/chunk_manager/base';
import {Borrowed} from 'neuroglancer/util/disposable';
import {stableStringify} from 'neuroglancer/util/json';
import {StringMemoize} from 'neuroglancer/util/memoize';
import {getObjectId} from 'neuroglancer/util/object_id';
import {NullarySignal} from 'neuroglancer/util/signal';
import {GL} from 'neuroglancer/webgl/context';
import {registerRPC, registerSharedObjectOwner, RPC, SharedObject} from 'neuroglancer/worker_rpc';

const DEBUG_CHUNK_UPDATES = false;

export abstract class Chunk {
  state = ChunkState.SYSTEM_MEMORY;
  constructor(public source: ChunkSource) {}

  get gl() {
    return this.source.gl;
  }

  copyToGPU(_gl: GL) {
    this.state = ChunkState.GPU_MEMORY;
  }

  freeGPUMemory(_gl: GL) {
    this.state = ChunkState.SYSTEM_MEMORY;
  }
}

@registerSharedObjectOwner(CHUNK_QUEUE_MANAGER_RPC_ID)
export class ChunkQueueManager extends SharedObject {
  visibleChunksChanged = new NullarySignal();
  pendingChunkUpdates: any = null;
  pendingChunkUpdatesTail: any = null;

  /**
   * If non-null, deadline in milliseconds since epoch after which chunk copies to the GPU may not
   * start (until the next frame).
   */
  chunkUpdateDeadline: number|null = null;

  chunkUpdateDelay: number = 30;

  constructor(rpc: RPC, public gl: GL, capacities: {
    gpuMemory: AvailableCapacity,
    systemMemory: AvailableCapacity,
    download: AvailableCapacity
  }) {
    super();
    this.initializeCounterpart(rpc, {
      'gpuMemoryCapacity': capacities.gpuMemory.toObject(),
      'systemMemoryCapacity': capacities.systemMemory.toObject(),
      'downloadCapacity': capacities.download.toObject()
    });
  }

  scheduleChunkUpdate() {
    let deadline = this.chunkUpdateDeadline;
    let delay: number;
    if (deadline === null || Date.now() < deadline) {
      delay = 0;
    } else {
      delay = this.chunkUpdateDelay;
    }
    setTimeout(this.processPendingChunkUpdates.bind(this), delay);
  }
  processPendingChunkUpdates() {
    let deadline = this.chunkUpdateDeadline;
    if (deadline !== null && Date.now() > deadline) {
      // No time to perform chunk update now, we will wait some more.
      setTimeout(this.processPendingChunkUpdates.bind(this), this.chunkUpdateDelay);
      return;
    }
    let update = this.pendingChunkUpdates;
    let {rpc} = this;
    let source = rpc!.get(update['source']);
    if (DEBUG_CHUNK_UPDATES) {
      console.log(
          `${Date.now()} Chunk.update processed: ${source.rpcId} ` +
          `${update['id']} ${update['state']}`);
    }
    let newState: number = update['state'];
    if (newState === ChunkState.EXPIRED) {
      // FIXME: maybe use freeList for chunks here
      source.deleteChunk(update['id']);
    } else {
      let chunk: Chunk;
      let key = update['id'];
      if (update['new']) {
        chunk = source.getChunk(update);
        source.addChunk(key, chunk);
      } else {
        chunk = source.chunks.get(key);
      }
      let oldState = chunk.state;
      if (newState !== oldState) {
        switch (newState) {
          case ChunkState.GPU_MEMORY:
            // console.log("Copying to GPU", chunk);
            chunk.copyToGPU(this.gl);
            this.visibleChunksChanged.dispatch();
            break;
          case ChunkState.SYSTEM_MEMORY:
            chunk.freeGPUMemory(this.gl);
            break;
          default:
            throw new Error(`INTERNAL ERROR: Invalid chunk state: ${ChunkState[newState]}`);
        }
      }
    }
    let nextUpdate = this.pendingChunkUpdates = update.nextUpdate;
    if (nextUpdate != null) {
      this.scheduleChunkUpdate();
    } else {
      this.pendingChunkUpdatesTail = null;
    }
  }
}

registerRPC('Chunk.update', function(x) {
  let source = this.get(x['source']);
  if (DEBUG_CHUNK_UPDATES) {
    console.log(
        `${Date.now()} Chunk.update received: ` +
        `${source.rpcId} ${x['id']} ${x['state']} with chunkDataSize ${x['chunkDataSize']}`);
  }
  let queueManager = source.chunkManager.chunkQueueManager;
  let pendingTail = queueManager.pendingChunkUpdatesTail;
  if (pendingTail == null) {
    queueManager.pendingChunkUpdates = x;
    queueManager.pendingChunkUpdatesTail = x;
    queueManager.scheduleChunkUpdate();
  } else {
    pendingTail.nextUpdate = x;
    queueManager.pendingChunkUpdatesTail = x;
  }
});

export interface ChunkSourceConstructor<Options, T = ChunkSource> {
  new(...args: any[]): T;
  encodeOptions(options: Options): {[key: string]: any};
}

@registerSharedObjectOwner(CHUNK_MANAGER_RPC_ID)
export class ChunkManager extends SharedObject {
  memoize = new StringMemoize();

  get gl() {
    return this.chunkQueueManager.gl;
  }

  constructor(public chunkQueueManager: ChunkQueueManager) {
    super();
    this.registerDisposer(chunkQueueManager.addRef());
    this.initializeCounterpart(
        chunkQueueManager.rpc!, {'chunkQueueManager': chunkQueueManager.rpcId});
  }

  getChunkSource<T extends ChunkSource, Options>(
      constructorFunction: ChunkSourceConstructor<Options, T>, options: any): T {
    const keyObject = constructorFunction.encodeOptions(options);
    keyObject['constructorId'] = getObjectId(constructorFunction);
    const key = stableStringify(keyObject);
    return this.memoize.get(key, () => {
      const newSource = new constructorFunction(this, options);
      newSource.initializeCounterpart(this.rpc!, {});
      return newSource;
    });
  }
}

export class ChunkSource extends SharedObject {
  chunks = new Map<string, Chunk>();

  constructor(public chunkManager: Borrowed<ChunkManager>, _options: {} = {}) {
    super();
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options['chunkManager'] = this.chunkManager.rpcId;
    super.initializeCounterpart(rpc, options);
  }

  get gl() {
    return this.chunkManager.chunkQueueManager.gl;
  }

  deleteChunk(key: string) {
    this.chunks.delete(key);
  }

  addChunk(key: string, chunk: Chunk) {
    this.chunks.set(key, chunk);
  }

  /**
   * Default implementation for use with backendOnly chunk sources.
   */
  getChunk(_x: any): Chunk {
    throw new Error('Not implemented.');
  }

  static encodeOptions(_options: {}): {[key: string]: any} {
    return {};
  }
}

export function
WithParameters<Parameters, BaseOptions, TBase extends ChunkSourceConstructor<BaseOptions>>(
    Base: TBase, parametersConstructor: ChunkSourceParametersConstructor<Parameters>) {
  type Options = BaseOptions&{parameters: Parameters};
  @registerSharedObjectOwner(parametersConstructor.RPC_ID)
  class C extends Base {
    parameters: Parameters;
    constructor(...args: any[]) {
      super(...args);
      const options: Options = args[1];
      this.parameters = options.parameters;
    }
    initializeCounterpart(rpc: RPC, options: any) {
      options['parameters'] = this.parameters;
      super.initializeCounterpart(rpc, options);
    }
    static encodeOptions(options: Options) {
      const encoding = super.encodeOptions(options);
      encoding['parameters'] = options.parameters;
      return encoding;
    }
  }
  return C;
}
