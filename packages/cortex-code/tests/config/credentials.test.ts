import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CredentialStore, type CredentialEntry } from '../../src/config/credentials.js';
import * as fs from 'node:fs/promises';
import * as childProcess from 'node:child_process';

vi.mock('node:fs/promises');
vi.mock('node:child_process');
vi.mock('proper-lockfile', () => ({
  default: {
    lock: vi.fn().mockResolvedValue(vi.fn().mockResolvedValue(undefined)),
  },
}));

const mockReadFile = vi.mocked(fs.readFile);
const mockWriteFile = vi.mocked(fs.writeFile);
const mockMkdir = vi.mocked(fs.mkdir);
const mockChmod = vi.mocked(fs.chmod);

/** What node's fs rejects with when the file does not exist. */
function missingFile(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
}

describe('CredentialStore', () => {
  let store: CredentialStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new CredentialStore();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  describe('load', () => {
    it('returns empty credential file when no file exists', async () => {
      mockReadFile.mockRejectedValue(missingFile());
      const file = await store.load();
      expect(file.version).toBe(1);
      expect(file.defaultProvider).toBeNull();
      expect(file.defaultModel).toBeNull();
      expect(file.defaultUtilityModels).toEqual({});
      expect(Object.keys(file.providers)).toHaveLength(0);
    });

    it('reads existing credential file', async () => {
      const data = {
        version: 1,
        defaultProvider: 'anthropic',
        defaultModel: 'claude-sonnet-4-6',
        providers: {
          anthropic: {
            provider: 'anthropic',
            method: 'api_key',
            apiKey: 'sk-test',
            addedAt: 1000,
          },
        },
      };
      mockReadFile.mockResolvedValue(JSON.stringify(data));
      const file = await store.load();
      expect(file.defaultProvider).toBe('anthropic');
      expect(file.defaultUtilityModels).toEqual({});
      expect(file.providers['anthropic']?.apiKey).toBe('sk-test');
    });
  });

  describe('getProvider', () => {
    it('returns null for unknown provider', async () => {
      mockReadFile.mockRejectedValue(missingFile());
      const entry = await store.getProvider('unknown');
      expect(entry).toBeNull();
    });

    it('returns stored provider entry', async () => {
      const data = {
        version: 1,
        defaultProvider: null,
        defaultModel: null,
        providers: {
          openai: {
            provider: 'openai',
            method: 'api_key',
            apiKey: 'sk-openai',
            addedAt: 1000,
          },
        },
      };
      mockReadFile.mockResolvedValue(JSON.stringify(data));
      const entry = await store.getProvider('openai');
      expect(entry).not.toBeNull();
      expect(entry?.apiKey).toBe('sk-openai');
    });
  });

  describe('setProvider', () => {
    it('writes credential entry to file with 0o600 permissions', async () => {
      // First read returns empty, lock succeeds, second read returns empty
      mockReadFile.mockResolvedValue(JSON.stringify({
        version: 1,
        defaultProvider: null,
        defaultModel: null,
        providers: {},
      }));

      const entry: CredentialEntry = {
        provider: 'anthropic',
        method: 'api_key',
        apiKey: 'sk-ant-test',
        addedAt: Date.now(),
      };

      await store.setProvider('anthropic', entry);

      // Should have written the file
      expect(mockWriteFile).toHaveBeenCalled();
      const writeCall = mockWriteFile.mock.calls[mockWriteFile.mock.calls.length - 1];
      expect(writeCall).toBeDefined();
      // Check file mode is 0o600
      const options = writeCall![2] as { mode?: number };
      expect(options?.mode).toBe(0o600);
    });
  });

  describe('hasProviders', () => {
    it('returns false when no providers configured', async () => {
      mockReadFile.mockRejectedValue(missingFile());
      expect(await store.hasProviders()).toBe(false);
    });

    it('returns true when providers exist', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        version: 1,
        defaultProvider: null,
        defaultModel: null,
        providers: { anthropic: { provider: 'anthropic', method: 'api_key', addedAt: 1 } },
      }));
      expect(await store.hasProviders()).toBe(true);
    });
  });

  describe('getDefaults / setDefaults', () => {
    it('returns null defaults when no file exists', async () => {
      mockReadFile.mockRejectedValue(missingFile());
      const defaults = await store.getDefaults();
      expect(defaults.provider).toBeNull();
      expect(defaults.model).toBeNull();
    });
  });

  describe('getDefaultUtilityModel / setDefaultUtilityModel', () => {
    it('returns null when no utility model is stored for the provider', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        version: 1,
        defaultProvider: null,
        defaultModel: null,
        defaultUtilityModels: {},
        providers: {},
      }));

      await expect(store.getDefaultUtilityModel('openai-codex')).resolves.toBeNull();
    });

    it('persists a utility model per provider', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        version: 1,
        defaultProvider: null,
        defaultModel: null,
        defaultUtilityModels: {},
        providers: {},
      }));

      await store.setDefaultUtilityModel('openai-codex', 'gpt-5.4-mini');

      const writeCall = mockWriteFile.mock.calls[mockWriteFile.mock.calls.length - 1];
      const written = JSON.parse(writeCall![1] as string);
      expect(written.defaultUtilityModels['openai-codex']).toBe('gpt-5.4-mini');
    });

    it('clears a stored utility model for a provider', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({
        version: 1,
        defaultProvider: null,
        defaultModel: null,
        defaultUtilityModels: { 'openai-codex': 'gpt-5.4-mini' },
        providers: {},
      }));

      await store.setDefaultUtilityModel('openai-codex', null);

      const writeCall = mockWriteFile.mock.calls[mockWriteFile.mock.calls.length - 1];
      const written = JSON.parse(writeCall![1] as string);
      expect(written.defaultUtilityModels['openai-codex']).toBeUndefined();
    });
  });
});
