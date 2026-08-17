import type { KVNamespace } from '@cloudflare/workers-types';
import type { EmailCache, EmailHandleStatus } from '../types';

export type AddressListStoreKey = 'BLOCK_LIST' | 'WHITE_LIST';

export class Dao {
  private readonly db: KVNamespace;

  constructor(db: KVNamespace) {
    this.db = db;
  }

  async loadArrayFromDB(key: AddressListStoreKey): Promise<string[]> {
    try {
      const raw = await this.db.get(key);
      return loadArrayFromRaw(raw);
    } catch (e) {
      console.error(e);
    }
    return [];
  }

  async saveArrayToDB(key: AddressListStoreKey, list: string[]): Promise<void> {
    await this.db.put(key, JSON.stringify(list));
  }

  async addAddress(address: string, type: AddressListStoreKey): Promise<void> {
    const list = await this.loadArrayFromDB(type);
    if (!list.includes(address)) {
      list.unshift(address);
      await this.saveArrayToDB(type, list);
    }
  }

  async removeAddress(address: string, type: AddressListStoreKey): Promise<void> {
    const list = await this.loadArrayFromDB(type);
    const result = list.filter(item => item !== address);
    await this.saveArrayToDB(type, result);
  }

  async loadMailStatus(id: string, guardian: boolean): Promise<EmailHandleStatus> {
    const defaultStatus: EmailHandleStatus = {
      discord: false,
      forward: [],
    };
    if (guardian) {
      try {
        const raw = await this.db.get(`Status:${id}`);
        if (raw) {
          return {
            ...defaultStatus,
            ...JSON.parse(raw),
          };
        }
      } catch (e) {
        console.error(e);
      }
    }
    return defaultStatus;
  }

  async saveMailStatus(id: string, status: EmailHandleStatus, ttl?: number): Promise<void> {
    await this.db.put(`Status:${id}`, JSON.stringify(status), { expirationTtl: ttl });
  }

  async loadMailCache(id: string): Promise<EmailCache | null> {
    try {
      const raw = await this.db.get(`Mail:${id}`);
      if (raw) {
        return JSON.parse(raw);
      }
    } catch (e) {
      console.error(e);
    }
    return null;
  }

  async saveMailCache(id: string, cache: EmailCache, ttl?: number): Promise<void> {
    await this.db.put(`Mail:${id}`, JSON.stringify(cache), { expirationTtl: ttl });
  }

  async messageIDToMailID(id: string): Promise<string | null> {
    return await this.db.get(`MsgID2MailID:${id}`);
  }

  async saveMessageIDToMailID(id: string, mailID: string, ttl?: number): Promise<void> {
    await this.db.put(`MsgID2MailID:${id}`, mailID, { expirationTtl: ttl });
  }
}

export function loadArrayFromRaw(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }
  let list: unknown = [];
  try {
    list = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter((item): item is string => typeof item === 'string');
}
