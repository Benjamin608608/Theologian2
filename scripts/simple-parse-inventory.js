const fs = require('fs');
const path = require('path');

/**
 * 簡化版解析器
 */

const inventoryPath = path.join(__dirname, '..', 'bible_vector_store_inventory.txt');
const outputPath = path.join(__dirname, '..', 'config', 'bible-books-config.json');

console.log('📋 解析向量資料庫清單...');

try {
  const content = fs.readFileSync(inventoryPath, 'utf8');
  const lines = content.split('\n');
  
  console.log(`讀取到 ${lines.length} 行`);
  
  const booksConfig = {};
  let currentBook = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // 檢查經卷標題（注意不要 trim，保持原始格式）
    const bookMatch = line.match(/^(\d+)\.\s+(.+)$/);
    if (bookMatch) {
      currentBook = bookMatch[2];
      console.log(`📖 找到經卷: ${currentBook}`);
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
    
    // 檢查資料庫信息
    if (line.includes('資料庫名稱：')) {
      booksConfig[currentBook].storeName = line.split('資料庫名稱：')[1]?.trim() || '';
    }
    
    if (line.includes('資料庫 ID：')) {
      booksConfig[currentBook].storeId = line.split('資料庫 ID：')[1]?.trim() || '';
    }
    
    if (line.includes('文件數量：')) {
      const numStr = line.split('文件數量：')[1]?.trim() || '0';
      booksConfig[currentBook].fileCount = parseInt(numStr);
    }
    
    // 檢查文件行（以 "  - [" 開頭）
    if (line.startsWith('  - [')) {
      const fileName = line.substring(4).trim(); // 移除 "  - "
      console.log(`📄 ${currentBook}: ${fileName}`);
      booksConfig[currentBook].files.push(fileName);
      
      // 提取作者
      const authorMatch = fileName.match(/^\[([^\]]+)\]/);
      if (authorMatch) {
        const authorFullName = authorMatch[1];
        const authorId = convertNameToId(authorFullName);
        
        // 檢查是否已存在此作者
        const existingAuthor = booksConfig[currentBook].authors.find(a => a.id === authorId);
        if (!existingAuthor) {
          booksConfig[currentBook].authors.push({
            id: authorId,
            name: extractName(authorFullName),
            fullName: authorFullName,
            dates: extractDates(authorFullName),
            files: [fileName]
          });
        } else {
          existingAuthor.files.push(fileName);
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

function extractName(fullName) {
  // 移除日期部分
  return fullName.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function extractDates(fullName) {
  const match = fullName.match(/\(([^)]*)\)$/);
  return match ? match[1] : '';
}

function convertNameToId(fullName) {
  const name = extractName(fullName).toLowerCase();
  
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
    'william m. groom': 'groom',
    'william m groom': 'groom',
    'george alexander chadwick': 'chadwick',
    'frederick charles cook': 'cook',
    's. h. kellogg': 'kellogg',
    's h kellogg': 'kellogg',
    'robert alexander watson': 'watson',
    'andrew harper': 'harper',
    'w. g. blaikie': 'blaikie',
    'w g blaikie': 'blaikie',
    'anonymous': 'anonymous'
  };
  
  // 檢查完全匹配
  if (knownAuthors[name]) {
    return knownAuthors[name];
  }
  
  // 檢查部分匹配
  for (const [key, value] of Object.entries(knownAuthors)) {
    if (name.includes(key.replace(/\./g, '')) || key.includes(name)) {
      return value;
    }
  }
  
  // 生成基於姓氏的 ID
  const words = name.split(' ');
  if (words.length > 1) {
    return words[words.length - 1].replace(/[^a-z]/g, '');
  }
  
  return name.replace(/[^a-z]/g, '');
}
