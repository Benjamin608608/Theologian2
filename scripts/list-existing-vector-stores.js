const OpenAI = require('openai');

/**
 * 列出所有現有的向量資料庫
 */

(async () => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required');
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    console.log('📋 獲取所有向量資料庫清單...\n');
    
    let after = undefined;
    let totalStores = 0;
    
    while (true) {
      const resp = await openai.vectorStores.list({ limit: 100, after });
      
      for (const store of resp.data) {
        totalStores++;
        console.log(`${totalStores}. ${store.name}`);
        console.log(`   ID: ${store.id}`);
        console.log(`   狀態: ${store.status}`);
        console.log(`   文件數: ${store.file_counts?.total || 0}`);
        console.log(`   創建時間: ${new Date(store.created_at * 1000).toLocaleString('zh-TW')}`);
        console.log('');
      }
      
      if (!resp.has_more) break;
      after = resp.last_id;
    }
    
    console.log(`總共找到 ${totalStores} 個向量資料庫`);

  } catch (error) {
    console.error('❌ 腳本執行失敗:', error.message);
    process.exit(1);
  }
})();
