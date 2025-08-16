const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

/**
 * 檢查主要向量資料庫中的文件
 */

(async () => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required');
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    
    // Railway 中設置的主要向量資料庫 ID
    const MAIN_VECTOR_STORE_ID = 'vs_6886f711eda0819189b6c017d6b23';

    console.log(`🔍 檢查主要向量資料庫: ${MAIN_VECTOR_STORE_ID}`);
    console.log('');

    try {
      // 獲取向量資料庫資訊
      const store = await openai.vectorStores.retrieve(MAIN_VECTOR_STORE_ID);
      
      console.log(`✅ 主要向量資料庫資訊:`);
      console.log(`   名稱: ${store.name}`);
      console.log(`   ID: ${store.id}`);
      console.log(`   狀態: ${store.status}`);
      console.log(`   文件數量: ${store.file_counts?.total || 0}`);
      console.log(`   創建時間: ${new Date(store.created_at * 1000).toLocaleString('zh-TW')}`);
      console.log('');

      if (store.file_counts?.total > 0) {
        console.log(`📁 文件清單 (前 50 個):`);
        console.log('');
        
        let outputContent = `主要向量資料庫文件清單\n`;
        outputContent += `====================\n\n`;
        outputContent += `資料庫名稱: ${store.name}\n`;
        outputContent += `資料庫 ID: ${store.id}\n`;
        outputContent += `文件總數: ${store.file_counts.total}\n`;
        outputContent += `查詢時間: ${new Date().toLocaleString('zh-TW')}\n\n`;
        outputContent += `文件清單:\n`;
        outputContent += `--------\n`;

        // 分頁獲取所有文件
        let after = undefined;
        let fileCount = 0;
        let biblicalFiles = 0;
        const authorStats = new Map();
        const bookStats = new Map();

        while (true) {
          const files = await openai.vectorStores.files.list(store.id, {
            limit: 100,
            after: after
          });

          for (const file of files.data) {
            fileCount++;
            
            try {
              const fileDetails = await openai.files.retrieve(file.id);
              const filename = fileDetails.filename;
              
              console.log(`${fileCount}. ${filename} (${fileDetails.bytes} bytes)`);
              outputContent += `${fileCount}. ${filename} (${fileDetails.bytes} bytes)\n`;

              // 分析文件名以統計內容
              const lowerName = filename.toLowerCase();
              
              // 檢查是否為聖經相關
              const bibleBooks = [
                'genesis', 'exodus', 'leviticus', 'numbers', 'deuteronomy',
                'joshua', 'judges', 'ruth', 'samuel', 'kings', 'chronicles',
                'ezra', 'nehemiah', 'esther', 'job', 'psalms', 'proverbs',
                'ecclesiastes', 'song', 'isaiah', 'jeremiah', 'lamentations',
                'ezekiel', 'daniel', 'hosea', 'joel', 'amos', 'obadiah',
                'jonah', 'micah', 'nahum', 'habakkuk', 'zephaniah', 'haggai',
                'zechariah', 'malachi', 'matthew', 'mark', 'luke', 'john',
                'acts', 'romans', 'corinthians', 'galatians', 'ephesians',
                'philippians', 'colossians', 'thessalonians', 'timothy',
                'titus', 'philemon', 'hebrews', 'james', 'peter', 'jude',
                'revelation'
              ];

              const isBiblical = bibleBooks.some(book => lowerName.includes(book));
              if (isBiblical) {
                biblicalFiles++;
              }

              // 統計作者
              const authors = ['calvin', 'luther', 'augustine', 'chrysostom', 'aquinas', 'wesley', 'spurgeon', 'henry', 'clarke', 'gill'];
              for (const author of authors) {
                if (lowerName.includes(author)) {
                  authorStats.set(author, (authorStats.get(author) || 0) + 1);
                }
              }

              // 統計經卷
              for (const book of bibleBooks) {
                if (lowerName.includes(book)) {
                  bookStats.set(book, (bookStats.get(book) || 0) + 1);
                }
              }

            } catch (fileError) {
              console.log(`${fileCount}. ${file.id} (無法獲取文件名)`);
              outputContent += `${fileCount}. ${file.id} (無法獲取文件名)\n`;
            }

            // 避免輸出過多，只顯示前50個
            if (fileCount >= 50 && console.log === console.log) {
              console.log(`   ... 還有 ${store.file_counts.total - fileCount} 個文件 ...`);
              break;
            }
          }

          if (!files.has_more || fileCount >= 50) break;
          after = files.last_id;
        }

        // 添加統計資訊
        outputContent += `\n統計分析:\n`;
        outputContent += `=========\n`;
        outputContent += `聖經相關文件: ${biblicalFiles}\n`;
        outputContent += `\n作者統計:\n`;
        for (const [author, count] of [...authorStats.entries()].sort((a, b) => b[1] - a[1])) {
          outputContent += `  ${author}: ${count} 個文件\n`;
        }
        outputContent += `\n經卷統計 (前10名):\n`;
        const topBooks = [...bookStats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
        for (const [book, count] of topBooks) {
          outputContent += `  ${book}: ${count} 個文件\n`;
        }

        // 保存到文件
        const outputPath = path.join(__dirname, '..', 'main_vector_store_files.txt');
        fs.writeFileSync(outputPath, outputContent, 'utf8');

        console.log('');
        console.log(`📊 統計摘要:`);
        console.log(`   總文件數: ${store.file_counts.total}`);
        console.log(`   聖經相關: ${biblicalFiles}`);
        console.log(`   作者覆蓋: ${authorStats.size} 位`);
        console.log(`   經卷覆蓋: ${bookStats.size} 卷`);
        console.log(`📄 完整清單已保存至: ${outputPath}`);

      } else {
        console.log(`📭 資料庫為空`);
      }

    } catch (error) {
      if (error.status === 404) {
        console.log(`❌ 向量資料庫不存在: ${MAIN_VECTOR_STORE_ID}`);
        console.log(`💡 可能需要重新建立資料庫`);
      } else {
        console.log(`❌ 檢查失敗: ${error.message}`);
      }
    }

  } catch (error) {
    console.error('❌ 腳本執行失敗:', error.message);
    process.exit(1);
  }
})();
