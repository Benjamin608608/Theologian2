const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

/**
 * 列出所有66個聖經經卷向量資料庫中的文件名稱
 * 
 * 使用方式：
 * OPENAI_API_KEY=... node scripts/list-all-bible-vector-store-files.js
 * 
 * 輸出：
 * - 在控制台顯示進度
 * - 生成 bible_vector_store_files.txt 文件
 */

(async () => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required');
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const STORE_PREFIX = process.env.BIBLE_STORE_PREFIX || 'Bible-';

    // 66個聖經經卷清單
    const books = [
      // 舊約 (39卷)
      'Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy',
      'Joshua', 'Judges', 'Ruth', '1 Samuel', '2 Samuel',
      '1 Kings', '2 Kings', '1 Chronicles', '2 Chronicles', 'Ezra',
      'Nehemiah', 'Esther', 'Job', 'Psalms', 'Proverbs',
      'Ecclesiastes', 'Song of Songs', 'Isaiah', 'Jeremiah', 'Lamentations',
      'Ezekiel', 'Daniel', 'Hosea', 'Joel', 'Amos',
      'Obadiah', 'Jonah', 'Micah', 'Nahum', 'Habakkuk',
      'Zephaniah', 'Haggai', 'Zechariah', 'Malachi',
      
      // 新約 (27卷)
      'Matthew', 'Mark', 'Luke', 'John', 'Acts',
      'Romans', '1 Corinthians', '2 Corinthians', 'Galatians', 'Ephesians',
      'Philippians', 'Colossians', '1 Thessalonians', '2 Thessalonians', '1 Timothy',
      '2 Timothy', 'Titus', 'Philemon', 'Hebrews', 'James',
      '1 Peter', '2 Peter', '1 John', '2 John', '3 John',
      'Jude', 'Revelation'
    ];

    console.log(`🚀 開始查詢 ${books.length} 個聖經經卷的向量資料庫文件...`);
    console.log(`📂 資料庫前綴: ${STORE_PREFIX}`);
    console.log('');

    let outputContent = `聖經66卷經卷向量資料庫文件清單\n`;
    outputContent += `=====================================\n\n`;
    outputContent += `查詢時間: ${new Date().toLocaleString('zh-TW')}\n`;
    outputContent += `資料庫前綴: ${STORE_PREFIX}\n\n`;

    let totalFiles = 0;
    let availableStores = 0;
    let unavailableStores = 0;

    // 首先獲取所有向量資料庫清單
    console.log('📋 獲取所有向量資料庫清單...');
    const storeMap = new Map();
    
    // 分頁獲取所有向量資料庫
    let after = undefined;
    while (true) {
      const resp = await openai.vectorStores.list({ limit: 100, after });
      
      for (const store of resp.data) {
        storeMap.set(store.name, store);
      }
      
      if (!resp.has_more) break;
      after = resp.last_id;
    }

    for (let i = 0; i < books.length; i++) {
      const bookEn = books[i];
      const storeName = `${STORE_PREFIX}${bookEn}`;
      
      console.log(`📖 [${i + 1}/66] 查詢 ${bookEn}...`);
      
      outputContent += `${i + 1}. ${bookEn}\n`;
      outputContent += `資料庫名稱: ${storeName}\n`;

      try {
        // 檢查資料庫是否存在
        const store = storeMap.get(storeName);
        
        if (!store) {
          console.log(`   ❌ 資料庫不存在: ${storeName}`);
          outputContent += `狀態: ❌ 資料庫不存在\n`;
          outputContent += `\n`;
          unavailableStores++;
          continue;
        }

        outputContent += `資料庫 ID: ${store.id}\n`;
        outputContent += `狀態: ${store.status}\n`;
        outputContent += `文件數量: ${store.file_counts?.total || 0}\n`;

        // 如果有文件，列出文件清單
        if (store.file_counts?.total > 0) {
          console.log(`   📁 查詢文件清單... (${store.file_counts.total} 個文件)`);
          
          const files = await openai.vectorStores.files.list(store.id, {
            limit: 100  // 如果文件很多，可能需要分頁
          });

          outputContent += `文件清單:\n`;
          
          for (const file of files.data) {
            // 獲取文件詳細資訊以取得文件名
            try {
              const fileDetails = await openai.files.retrieve(file.id);
              outputContent += `  - ${fileDetails.filename} (${fileDetails.bytes} bytes)\n`;
              console.log(`     📄 ${fileDetails.filename}`);
            } catch (fileError) {
              outputContent += `  - ${file.id} (無法獲取文件名)\n`;
              console.log(`     📄 ${file.id} (無法獲取文件名)`);
            }
          }
          
          totalFiles += files.data.length;
          availableStores++;
          
          // 如果有更多文件需要分頁處理
          if (files.has_more) {
            outputContent += `  (... 還有更多文件，需要分頁查詢)\n`;
            console.log(`     ⚠️  還有更多文件，需要分頁查詢`);
          }
        } else {
          console.log(`   📭 資料庫為空`);
          outputContent += `文件清單: (資料庫為空)\n`;
          availableStores++;
        }

      } catch (error) {
        console.log(`   ❌ 查詢失敗: ${error.message}`);
        outputContent += `狀態: ❌ 查詢失敗 - ${error.message}\n`;
        unavailableStores++;
      }

      outputContent += `\n`;
      
      // 避免 API 速率限制
      if (i < books.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // 添加統計摘要
    outputContent += `查詢統計摘要\n`;
    outputContent += `=============\n`;
    outputContent += `總經卷數: ${books.length}\n`;
    outputContent += `可用資料庫: ${availableStores}\n`;
    outputContent += `不可用資料庫: ${unavailableStores}\n`;
    outputContent += `總文件數: ${totalFiles}\n`;

    // 寫入文件
    const outputPath = path.join(__dirname, '..', 'bible_vector_store_files.txt');
    fs.writeFileSync(outputPath, outputContent, 'utf8');

    console.log('');
    console.log('✅ 查詢完成！');
    console.log(`📊 統計:`);
    console.log(`   - 總經卷數: ${books.length}`);
    console.log(`   - 可用資料庫: ${availableStores}`);
    console.log(`   - 不可用資料庫: ${unavailableStores}`);
    console.log(`   - 總文件數: ${totalFiles}`);
    console.log(`📄 結果已保存至: ${outputPath}`);

  } catch (error) {
    console.error('❌ 腳本執行失敗:', error.message);
    process.exit(1);
  }
})();
