const fs = require('fs');
const path = require('path');

/**
 * 解析 bible_vector_store_inventory.txt 並生成 JSON 配置
 */

const inventoryPath = path.join(__dirname, '..', 'bible_vector_store_inventory.txt');
const outputPath = path.join(__dirname, '..', 'config', 'bible-books-config.json');

console.log('📋 解析向量資料庫清單...');

try {
  const content = fs.readFileSync(inventoryPath, 'utf8');
  const lines = content.split('\n');
  
  const booksConfig = {};
  let currentBook = null;
  let isInFileList = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // 匹配經卷標題：1. Genesis
    const bookMatch = line.match(/^(\d+)\.\s+(.+)$/);
    if (bookMatch) {
      currentBook = bookMatch[2];
      isInFileList = false;
      booksConfig[currentBook] = {
        order: parseInt(bookMatch[1]),
        storeName: '',
        storeId: '',
        fileCount: 0,
        files: [],
        authors: []
      };
      continue;
    }
    
    if (!currentBook) continue;
    
    // 檢查是否進入文件清單區域
    if (line === '文件清單：') {
      isInFileList = true;
      continue;
    }
    
    // 空行重置文件清單狀態
    if (line === '') {
      isInFileList = false;
      continue;
    }
    
    // 匹配資料庫名稱
    if (line.startsWith('資料庫名稱：')) {
      booksConfig[currentBook].storeName = line.replace('資料庫名稱：', '').trim();
    }
    
    // 匹配資料庫 ID
    if (line.startsWith('資料庫 ID：')) {
      booksConfig[currentBook].storeId = line.replace('資料庫 ID：', '').trim();
    }
    
    // 匹配文件數量
    if (line.startsWith('文件數量：')) {
      booksConfig[currentBook].fileCount = parseInt(line.replace('文件數量：', '').trim());
    }
    
    // 匹配文件清單
    if (isInFileList && line.startsWith('  - ')) {
      const fileName = line.replace('  - ', '').trim();
      console.log(`📄 ${currentBook}: ${fileName}`);
      booksConfig[currentBook].files.push(fileName);
      
      // 從文件名提取作者
      const authorMatch = fileName.match(/^\[([^\]]+)\]/);
      if (authorMatch) {
        const authorFullName = authorMatch[1];
        
        // 提取作者姓名和年代
        const nameMatch = authorFullName.match(/^([^(]+?)(?:\s*\(([^)]+)\))?$/);
        if (nameMatch) {
          const name = nameMatch[1].trim();
          const dates = nameMatch[2] || '';
          
          // 轉換為作者 ID
          const authorId = convertNameToId(name);
          
          // 檢查是否已存在
          const existingAuthor = booksConfig[currentBook].authors.find(a => a.id === authorId);
          if (!existingAuthor) {
            booksConfig[currentBook].authors.push({
              id: authorId,
              name: name,
              fullName: authorFullName,
              dates: dates,
              files: [fileName]
            });
          } else {
            existingAuthor.files.push(fileName);
          }
        }
      }
    }
  }
  
  // 確保 config 目錄存在
  const configDir = path.dirname(outputPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  // 寫入 JSON 文件
  fs.writeFileSync(outputPath, JSON.stringify(booksConfig, null, 2), 'utf8');
  
  console.log(`✅ 解析完成，輸出到: ${outputPath}`);
  console.log(`📊 統計:`);
  console.log(`   - 經卷數: ${Object.keys(booksConfig).length}`);
  
  let totalAuthors = 0;
  let totalFiles = 0;
  for (const book of Object.values(booksConfig)) {
    totalAuthors += book.authors.length;
    totalFiles += book.files.length;
  }
  console.log(`   - 總作者數: ${totalAuthors}`);
  console.log(`   - 總文件數: ${totalFiles}`);
  
} catch (error) {
  console.error('❌ 解析失敗:', error.message);
  process.exit(1);
}

/**
 * 將作者姓名轉換為標準 ID
 */
function convertNameToId(name) {
  const normalizedName = name.toLowerCase().replace(/[^a-z\s]/g, '').trim();
  
  // 已知作者映射
  const knownAuthors = {
    'john calvin': 'calvin',
    'martin luther': 'luther',
    'augustine': 'augustine',
    'john chrysostom': 'chrysostom',
    'thomas aquinas': 'aquinas',
    'john wesley': 'wesley',
    'charles spurgeon': 'spurgeon',
    'matthew henry': 'henry',
    'adam clarke': 'clarke',
    'john gill': 'gill',
    'alexander maclaren': 'maclaren',
    'marcus dods': 'dods',
    'herbert carl leupold': 'leupold',
    'william m groom': 'groom',
    'george alexander chadwick': 'chadwick',
    'frederick charles cook': 'cook',
    's h kellogg': 'kellogg',
    'robert alexander watson': 'watson',
    'andrew harper': 'harper',
    'w g blaikie': 'blaikie',
    'anonymous': 'anonymous'
  };
  
  // 檢查完全匹配
  if (knownAuthors[normalizedName]) {
    return knownAuthors[normalizedName];
  }
  
  // 檢查部分匹配
  for (const [key, value] of Object.entries(knownAuthors)) {
    if (normalizedName.includes(key) || key.includes(normalizedName)) {
      return value;
    }
  }
  
  // 生成基於姓氏的 ID
  const words = normalizedName.split(' ');
  if (words.length > 1) {
    return words[words.length - 1]; // 使用姓氏
  }
  
  return normalizedName.replace(/\s+/g, '');
}
