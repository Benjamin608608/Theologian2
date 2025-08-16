/**
 * 從 Railway 環境中獲取實際的 VECTOR_STORE_ID
 */

(async () => {
  try {
    console.log('🔍 從 Railway 獲取向量資料庫 ID...\n');
    
    // 創建一個端點來返回環境變數
    const urls = [
      'https://solaquinque.com',
      'https://dev.solaquinque.com'
    ];
    
    for (const baseUrl of urls) {
      console.log(`📡 檢查 ${baseUrl}...`);
      
      try {
        // 調用可能存在的調試端點
        const response = await fetch(`${baseUrl}/api/debug-env`);
        
        if (response.ok) {
          const data = await response.json();
          console.log('✅ 獲取環境變數:', data);
        } else {
          console.log(`❌ /api/debug-env 不可用 (${response.status})`);
        }
      } catch (error) {
        console.log(`❌ 無法連接到 ${baseUrl}: ${error.message}`);
      }
      
      console.log('');
    }
    
    console.log('💡 建議:');
    console.log('1. 檢查 Railway 儀表板中的環境變數設置');
    console.log('2. 確認 VECTOR_STORE_ID 是否正確設置');
    console.log('3. 檢查 OpenAI 儀表板中的向量資料庫');

  } catch (error) {
    console.error('❌ 腳本執行失敗:', error.message);
  }
})();
