const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

/**
 * 列出 66 卷聖經各自向量資料庫中的檔案清單
 * - 使用名稱匹配方式尋找資料庫（預設前綴 BIBLE_STORE_PREFIX=“Bible-”）
 * - 將每卷的「資料庫名稱、ID、檔案列表」寫入 bible_vector_store_inventory.txt
 *
 * 執行方式（請使用您的 OpenAI API 金鑰）：
 *   OPENAI_API_KEY=sk-xxxx node scripts/list-66-vector-stores-files.js
 */
(async () => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('請先設定 OPENAI_API_KEY');
    }
    const openai = new OpenAI({ apiKey });

    const STORE_PREFIX = process.env.BIBLE_STORE_PREFIX || 'Bible-';

    const books = [
      'Genesis','Exodus','Leviticus','Numbers','Deuteronomy','Joshua','Judges','Ruth',
      '1 Samuel','2 Samuel','1 Kings','2 Kings','1 Chronicles','2 Chronicles','Ezra','Nehemiah','Esther','Job','Psalms','Proverbs','Ecclesiastes','Song of Songs','Isaiah','Jeremiah','Lamentations','Ezekiel','Daniel','Hosea','Joel','Amos','Obadiah','Jonah','Micah','Nahum','Habakkuk','Zephaniah','Haggai','Zechariah','Malachi',
      'Matthew','Mark','Luke','John','Acts','Romans','1 Corinthians','2 Corinthians','Galatians','Ephesians','Philippians','Colossians','1 Thessalonians','2 Thessalonians','1 Timothy','2 Timothy','Titus','Philemon','Hebrews','James','1 Peter','2 Peter','1 John','2 John','3 John','Jude','Revelation'
    ];

    // 正規化名稱，方便不同比對
    const normalize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

    // 針對「雅歌」提供幾個常見同名
    const synonymTargets = new Map([
      ['bible-songofsongs', ['bible-songofsolomon', 'bible-canticles']]
    ]);

    console.log(`📚 準備列出 66 卷資料庫檔案，前綴：${STORE_PREFIX}`);

    // 先把所有向量庫列出來做索引
    console.log('📋 讀取所有向量資料庫列表...');
    const allStores = [];
    let after = undefined;
    while (true) {
      const resp = await openai.vectorStores.list({ limit: 100, after });
      allStores.push(...resp.data);
      if (!resp.has_more) break;
      after = resp.last_id;
    }

    if (allStores.length === 0) {
      console.log('⚠️ 未讀到任何向量資料庫，請確認 API 金鑰與專案是否正確。');
    }

    // 建立以多種鍵可取的映射表（含同名）
    const storeByNormName = new Map();
    for (const vs of allStores) {
      const name = vs.name || '';
      const norm = normalize(name);
      if (!storeByNormName.has(norm)) storeByNormName.set(norm, vs);
    }

    // 為現有的名稱建立同義名映射（如控制台中是 songofsolomon 也能被 songofsongs 查到）
    for (const [target, syns] of synonymTargets.entries()) {
      for (const vs of allStores) {
        const norm = normalize(vs.name);
        if (syns.includes(norm)) {
          // 允許用 target 這個 key 取到它
          if (!storeByNormName.has(target)) storeByNormName.set(target, vs);
        }
      }
    }

    // 建立輸出
    const lines = [];
    lines.push('聖經 66 卷向量資料庫檔案清單');
    lines.push('================================');
    lines.push(`查詢時間：${new Date().toLocaleString('zh-TW')}`);
    lines.push(`資料庫前綴：${STORE_PREFIX}`);
    lines.push('');

    let totalStoresFound = 0;
    let totalFiles = 0;

    for (let i = 0; i < books.length; i++) {
      const bookEn = books[i];
      const targetName = `${STORE_PREFIX}${bookEn}`;
      const targetNorm = normalize(targetName);

      // 精確匹配或近似匹配
      let store = storeByNormName.get(targetNorm);
      if (!store) {
        // 近似：忽略連字號/空白差異
        store = allStores.find(vs => normalize(vs.name).endsWith(normalize(bookEn)) && normalize(vs.name).startsWith(normalize(STORE_PREFIX))) || null;
      }
      if (!store && synonymTargets.has(targetNorm)) {
        const synNorms = synonymTargets.get(targetNorm) || [];
        for (const syn of synNorms) {
          const hit = storeByNormName.get(syn);
          if (hit) { store = hit; break; }
        }
      }

      lines.push(`${i + 1}. ${bookEn}`);
      lines.push(`資料庫名稱：${store ? (store.name || targetName) : targetName}`);

      if (!store) {
        lines.push('狀態：❌ 未找到此資料庫');
        lines.push('');
        continue;
      }

      lines.push(`資料庫 ID：${store.id}`);
      lines.push(`文件數量：${store.file_counts?.total || 0}`);

      totalStoresFound++;

      if ((store.file_counts?.total || 0) === 0) {
        lines.push('文件清單： (空)');
        lines.push('');
        continue;
      }

      lines.push('文件清單：');

      // 分頁列出該 store 的所有檔案
      let fileAfter = undefined;
      let fileIndex = 0;
      while (true) {
        const filesResp = await openai.vectorStores.files.list(store.id, { limit: 100, after: fileAfter });
        for (const f of filesResp.data) {
          fileIndex++;
          try {
            const meta = await openai.files.retrieve(f.id);
            lines.push(`  - ${meta.filename} (${meta.bytes} bytes)`);
          } catch (e) {
            lines.push(`  - ${f.id} (無法取得檔名)`);
          }
          // 輕微節流，避免觸發速率限制
          await new Promise(r => setTimeout(r, 30));
        }
        if (!filesResp.has_more) break;
        fileAfter = filesResp.last_id;
      }

      totalFiles += fileIndex;
      lines.push('');
    }

    lines.push('統計摘要');
    lines.push('--------');
    lines.push(`成功匹配資料庫：${totalStoresFound} / 66`);
    lines.push(`總檔案數（合計）：${totalFiles}`);

    const outPath = path.join(__dirname, '..', 'bible_vector_store_inventory.txt');
    fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

    console.log('✅ 已輸出清單：', outPath);
    console.log(`📦 匹配到的資料庫數：${totalStoresFound} / 66`);
    console.log(`📄 檔案總數（合計）：${totalFiles}`);
  } catch (err) {
    console.error('❌ 腳本失敗：', err.message);
    process.exit(1);
  }
})();
