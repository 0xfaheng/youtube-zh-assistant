import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Storage } from '../storage.mjs';
test('本机密钥可由 Windows DPAPI 加密并由相同用户解密', {skip:process.platform!=='win32'},async()=>{
  const storage=new Storage(path.resolve(import.meta.dirname,'../../../../work/storage-test'));
  const secret='dummy-key-for-encryption-test';
  const encrypted=await storage.dpapi('Protect',secret);
  assert.equal(encrypted.includes(secret),false);
  assert.equal(await storage.dpapi('Unprotect',encrypted),secret);
});
