const OpenAI = require('openai');

/**
 * 調試 API 連接問題
 */

(async () => {
  try {
    console.log('🔍 調試 OpenAI API 連接...\n');
    
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required');
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // 測試 API 連接
    console.log('1. 測試基本 API 連接...');
    try {
      const models = await openai.models.list();
      console.log(`✅ API 連接正常，找到 ${models.data.length} 個模型`);
    } catch (error) {
      console.log(`❌ API 連接失敗: ${error.message}`);
      return;
    }

    // 測試向量資料庫 API
    console.log('\n2. 測試向量資料庫 API...');
    try {
      // 使用您提供的向量資料庫 ID
      const knownStoreId = 'vs_68962be0a2b08191aa2656c1f4969168';
      console.log(`📋 檢查已知的向量資料庫: ${knownStoreId}`);
      
      const store = await openai.vectorStores.retrieve(knownStoreId);
      console.log(`✅ 成功獲取向量資料庫:`);
      console.log(`   名稱: ${store.name}`);
      console.log(`   ID: ${store.id}`);
      console.log(`   狀態: ${store.status}`);
      console.log(`   文件數: ${store.file_counts?.total || 0}`);
      
    } catch (error) {
      console.log(`❌ 向量資料庫檢查失敗: ${error.message}`);
    }

    // 重新嘗試列出所有向量資料庫
    console.log('\n3. 重新列出所有向量資料庫...');
    try {
      let after = undefined;
      let totalStores = 0;
      let page = 1;
      
      while (true) {
        console.log(`📄 獲取第 ${page} 頁...`);
        const resp = await openai.vectorStores.list({ limit: 20, after });
        
        console.log(`   返回 ${resp.data.length} 個結果`);
        
        if (resp.data.length === 0) {
          console.log('   沒有更多資料');
          break;
        }
        
        for (const store of resp.data) {
          totalStores++;
          console.log(`   ${totalStores}. ${store.name} (${store.file_counts?.total || 0} 文件)`);
        }
        
        if (!resp.has_more) {
          console.log('   已到最後一頁');
          break;
        }
        
        after = resp.last_id;
        page++;
        
        // 避免無限循環
        if (page > 10) {
          console.log('   達到最大頁數限制');
          break;
        }
      }
      
      console.log(`\n📊 總共找到 ${totalStores} 個向量資料庫`);
      
    } catch (error) {
      console.log(`❌ 列表查詢失敗: ${error.message}`);
      console.log(`錯誤詳情:`, error);
    }

    // 檢查 API 金鑰權限
    console.log('\n4. 檢查 API 金鑰權限...');
    try {
      // 嘗試訪問組織資訊（如果有權限）
      const usage = await openai.usage.completions({ 
        start_time: Math.floor((Date.now() - 86400000) / 1000), // 24小時前
        end_time: Math.floor(Date.now() / 1000)
      });
      console.log('✅ API 金鑰有高級權限');
    } catch (error) {
      console.log('ℹ️ API 金鑰權限有限（這是正常的）');
    }

  } catch (error) {
    console.error('❌ 調試腳本失敗:', error.message);
    console.error('完整錯誤:', error);
  }
})();
