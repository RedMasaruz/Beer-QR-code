'use strict';

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createPersistence({ dataFile, imageDir }) {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  const bucket = String(process.env.SUPABASE_BUCKET || 'menu-images');
  const remote = Boolean(url && serviceKey);
  const supabase = remote
    ? createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;
  let saveQueue = Promise.resolve();

  async function load(fallback) {
    if (!remote) {
      try {
        return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      } catch (error) {
        fs.mkdirSync(path.dirname(dataFile), { recursive: true });
        fs.writeFileSync(dataFile, JSON.stringify(fallback, null, 2));
        return clone(fallback);
      }
    }

    const { data, error } = await supabase
      .from('app_state')
      .select('data')
      .eq('id', 1)
      .maybeSingle();
    if (error) throw new Error(`Supabase load failed: ${error.message}`);
    if (data && data.data) return data.data;
    await save(fallback);
    return clone(fallback);
  }

  async function writeSnapshot(snapshot) {
    if (!remote) {
      fs.mkdirSync(path.dirname(dataFile), { recursive: true });
      const tmp = `${dataFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
      fs.renameSync(tmp, dataFile);
      return;
    }
    const { error } = await supabase.from('app_state').upsert({
      id: 1,
      data: snapshot,
      updated_at: new Date().toISOString(),
    });
    if (error) throw new Error(`Supabase save failed: ${error.message}`);
  }

  function save(value) {
    const snapshot = clone(value);
    const task = saveQueue.then(() => writeSnapshot(snapshot));
    saveQueue = task.catch(() => {});
    return task;
  }

  async function getImage(name) {
    if (!remote) return fs.promises.readFile(path.join(imageDir, name));
    const { data, error } = await supabase.storage.from(bucket).download(name);
    if (error) throw new Error(`Supabase image download failed: ${error.message}`);
    return Buffer.from(await data.arrayBuffer());
  }

  async function putImage(name, buffer) {
    if (!remote) {
      await fs.promises.mkdir(imageDir, { recursive: true });
      await fs.promises.writeFile(path.join(imageDir, name), buffer);
      return;
    }
    const { error } = await supabase.storage.from(bucket).upload(name, buffer, {
      contentType: 'image/jpeg',
      cacheControl: '31536000',
      upsert: false,
    });
    if (error) throw new Error(`Supabase image upload failed: ${error.message}`);
  }

  async function removeImage(name) {
    if (!name || !/^[a-f0-9]{10}\.jpg$/.test(name)) return;
    if (!remote) {
      try { await fs.promises.unlink(path.join(imageDir, name)); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      return;
    }
    const { error } = await supabase.storage.from(bucket).remove([name]);
    if (error) throw new Error(`Supabase image delete failed: ${error.message}`);
  }

  return { remote, load, save, getImage, putImage, removeImage };
}

module.exports = { createPersistence };
