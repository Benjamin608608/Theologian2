const OpenAI = require('openai');

/**
 * 使用 Railway 上的 VECTOR_STORE_ID 檢查向量資料庫
 */

(async () => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required');
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // 從 Railway 生產環境獲取 vector store ID
    console.log('🔍 檢查 Railway 環境的向量資料庫配置...\n');
    
    // 先嘗試一些常見的向量資料庫 ID（從 env.example 和日誌中找到的）
    const potentialStoreIds = [
      'vs_6886f711eda0819189b6c017d6b96d23', // 來自 env.example
      // 可以添加更多從日誌中發現的 ID
    ];

    for (const storeId of potentialStoreIds) {
      try {
        console.log(`🔍 檢查 ${storeId}...`);
        const store = await openai.vectorStores.retrieve(storeId);
        console.log(`✅ 找到向量資料庫:`);
        console.log(`   名稱: ${store.name}`);
        console.log(`   ID: ${store.id}`);
        console.log(`   狀態: ${store.status}`);
        console.log(`   文件數: ${store.file_counts?.total || 0}`);
        console.log(`   創建時間: ${new Date(store.created_at * 1000).toLocaleString('zh-TW')}`);
        console.log('');

        // 如果有文件，列出前幾個
        if (store.file_counts?.total > 0) {
          console.log('📁 前幾個文件:');
          const files = await openai.vectorStores.files.list(store.id, { limit: 5 });
          
          for (const file of files.data) {
            try {
              const fileDetails = await openai.files.retrieve(file.id);
              console.log(`   - ${fileDetails.filename} (${fileDetails.bytes} bytes)`);
            } catch (fileError) {
              console.log(`   - ${file.id} (無法獲取文件名)`);
            }
          }
          console.log('');
        }

      } catch (error) {
        if (error.status === 404) {
          console.log(`❌ 向量資料庫不存在: ${storeId}`);
        } else {
          console.log(`❌ 檢查失敗: ${error.message}`);
        }
      }
    }

    // 列出所有向量資料庫
    console.log('📋 列出所有現有的向量資料庫...\n');
    
    let after = undefined;
    let totalStores = 0;
    let bibleStores = 0;
    
    while (true) {
      const resp = await openai.vectorStores.list({ limit: 100, after });
      
      for (const store of resp.data) {
        totalStores++;
        const isBibleStore = store.name.includes('Bible') || store.name.includes('bible');
        
        if (isBibleStore) {
          bibleStores++;
          console.log(`📖 ${store.name}`);
          console.log(`   ID: ${store.id}`);
          console.log(`   文件數: ${store.file_counts?.total || 0}`);
          console.log('');
        } else {
          console.log(`📚 ${store.name} (${store.file_counts?.total || 0} 文件)`);
        }
      }
      
      if (!resp.has_more) break;
      after = resp.last_id;
    }
    
    console.log(`\n📊 總結:`);
    console.log(`   總向量資料庫: ${totalStores}`);
    console.log(`   聖經相關資料庫: ${bibleStores}`);

  } catch (error) {
    console.error('❌ 腳本執行失敗:', error.message);
    process.exit(1);
  }
})();
