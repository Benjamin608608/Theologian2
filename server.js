const express = require('express');
const cors = require('cors');
const path = require('path');
const OpenAI = require('openai');
const session = require('express-session');
const passport = require('passport');
require('dotenv').config();
const { MongoClient } = require('mongodb');
const fs = require('fs');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

// 全局變數
let globalAssistant = null;
let processingRequests = new Map();
const CACHE_DURATION = 30 * 60 * 1000; // 30 分鐘
let assistantWarmupInterval = null; // 定期保溫計時器

// 作者對照表
let authorTranslations = {};

// 載入作者對照表
async function loadAuthorTranslations() {
    try {
        const fs = await import('fs');
        const path = await import('path');
        const filePath = path.join(process.cwd(), 'config', 'author-translations.json');
        
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            authorTranslations = JSON.parse(data);
            console.log(`✅ 已載入作者對照表 (${Object.keys(authorTranslations).length} 位作者)`);
        } else {
            console.warn('⚠️ 作者對照表文件不存在');
        }
    } catch (error) {
        console.error('❌ 載入作者對照表失敗:', error.message);
    }
}

// 獲取作者名稱（根據語言）
function getAuthorName(englishName, language = 'zh') {
  if (!englishName) return '';
  
  if (language === 'zh' && authorTranslations.authors[englishName]) {
    return authorTranslations.authors[englishName];
  }
  return englishName;
}



// 讓 express-session 支援 proxy (如 Railway/Heroku/Render)
app.set('trust proxy', 1);

// 初始化 OpenAI 客戶端
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 你的向量資料庫 ID
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID || 'vs_6886f711eda0819189b6c017d6b96d23';

// MongoDB Atlas 連線
let mongoClient, loginLogsCollection;

async function connectToMongoDB() {
  if (!process.env.MONGO_URI) {
    console.warn('⚠️  MONGO_URI 環境變數未設置，MongoDB 功能將不可用');
    return;
  }
  
  try {
    mongoClient = new MongoClient(process.env.MONGO_URI, { 
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000
    });
    await mongoClient.connect();
    const db = mongoClient.db('theologian');
    loginLogsCollection = db.collection('loginLogs');
    console.log('✅ 已連線 MongoDB Atlas (theologian.loginLogs)');
  } catch (err) {
    console.error('❌ 連線 MongoDB Atlas 失敗:', err.message);
    console.log('💡 應用程式將繼續運行，但登入記錄功能將不可用');
  }
}

// 初始化 MongoDB 連線
connectToMongoDB();

// Session 配置（改良版，支援移動設備）
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // 只在生產環境使用 secure
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 小時
    sameSite: 'lax' // 改善移動設備相容性
  },
  name: 'theologian.sid' // 自定義 session cookie 名稱
}));

// Passport 配置
app.use(passport.initialize());
app.use(passport.session());

// Passport 序列化
passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

// 條件性 Google OAuth 配置
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  const GoogleStrategy = require('passport-google-oauth20').Strategy;
  
  passport.use(new GoogleStrategy({
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL || "http://localhost:3000/auth/google/callback"
    },
    function(accessToken, refreshToken, profile, cb) {
      // 這裡可以添加用戶資料庫存儲邏輯
      const user = {
        id: profile.id,
        email: profile.emails[0].value,
        name: profile.displayName,
        picture: profile.photos[0].value
      };
      return cb(null, user);
    }
  ));
} else {
  console.warn('⚠️  Google OAuth 憑證未設置，登入功能將不可用');
  console.warn('   請設置 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET 環境變數');
}

// 中間件設置
app.use(cors({
  origin: true, // 允許所有來源
  credentials: true, // 允許攜帶憑證
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 認證中間件
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ 
    success: false, 
    error: '需要登入才能使用此功能',
    requiresAuth: true 
  });
}

// 檢測是否為 LINE 瀏覽器
function isLineBrowser(userAgent) {
  return userAgent && (
    userAgent.includes('Line') || 
    userAgent.includes('LINE') ||
    userAgent.includes('line')
  );
}

// 檢測是否為內建瀏覽器
function isEmbeddedBrowser(userAgent) {
  return userAgent && (
    userAgent.includes('Line') ||
    userAgent.includes('Instagram') ||
    userAgent.includes('Facebook') ||
    userAgent.includes('Twitter') ||
    userAgent.includes('WhatsApp') ||
    userAgent.includes('Telegram') ||
    userAgent.includes('WeChat')
  );
}

// 獲取當前完整 URL
function getCurrentUrl(req) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${protocol}://${host}${req.originalUrl}`;
}

// 認證路由 - 僅在 Google OAuth 已配置時啟用
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  app.get('/auth/google', (req, res) => {
    const userAgent = req.get('User-Agent');
    const currentUrl = getCurrentUrl(req);
    
    // 檢測是否為內建瀏覽器
    if (isEmbeddedBrowser(userAgent)) {
      return res.status(200).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>請使用外部瀏覽器登入</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              margin: 0;
              padding: 20px;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
            }
            .container {
              background: white;
              padding: 40px;
              border-radius: 12px;
              box-shadow: 0 8px 32px rgba(0,0,0,0.1);
              text-align: center;
              max-width: 500px;
            }
            .icon {
              font-size: 48px;
              margin-bottom: 20px;
            }
            h1 {
              color: #333;
              margin-bottom: 20px;
            }
            p {
              color: #666;
              line-height: 1.6;
              margin-bottom: 20px;
            }
            .btn {
              background: #4285f4;
              color: white;
              padding: 12px 24px;
              border: none;
              border-radius: 6px;
              text-decoration: none;
              display: inline-block;
              margin: 10px;
              font-size: 16px;
              cursor: pointer;
            }
            .btn:hover {
              background: #3367d6;
            }
            .btn-secondary {
              background: #6c757d;
            }
            .btn-secondary:hover {
              background: #545b62;
            }
            .steps {
              text-align: left;
              background: #f8f9fa;
              padding: 20px;
              border-radius: 8px;
              margin: 20px 0;
            }
            .steps ol {
              margin: 0;
              padding-left: 20px;
            }
            .steps li {
              margin-bottom: 10px;
              color: #555;
            }
            .url-box {
              background: #e9ecef;
              padding: 10px;
              border-radius: 6px;
              margin: 15px 0;
              word-break: break-all;
              font-family: monospace;
              font-size: 12px;
            }
            .copy-btn {
              background: #28a745;
              color: white;
              padding: 8px 16px;
              border: none;
              border-radius: 4px;
              cursor: pointer;
              font-size: 14px;
              margin-top: 10px;
            }
            .copy-btn:hover {
              background: #218838;
            }
            .success {
              color: #28a745;
              font-weight: bold;
              margin-top: 10px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="icon">🌐</div>
            <h1>請使用外部瀏覽器登入</h1>
            <p>由於 Google 安全政策，無法在當前瀏覽器中完成登入。</p>
            
            <div class="steps">
              <h3>解決步驟：</h3>
              <ol>
                <li>點擊右上角的「...」或「更多選項」</li>
                <li>選擇「在瀏覽器中開啟」或「複製連結」</li>
                <li>在 Chrome、Safari 等外部瀏覽器中開啟</li>
                <li>完成 Google 登入</li>
              </ol>
            </div>
            
            <div class="url-box" id="urlBox">${currentUrl}</div>
            <button class="copy-btn" onclick="copyUrl()">複製連結</button>
            <div id="copyStatus"></div>
            
            <div style="margin-top: 20px;">
              <a href="/" class="btn btn-secondary">返回首頁</a>
              <button class="btn" onclick="openInNewWindow()">在新視窗開啟</button>
            </div>
          </div>
          
          <script>
            function copyUrl() {
              const url = '${currentUrl}';
              if (navigator.clipboard) {
                navigator.clipboard.writeText(url).then(() => {
                  document.getElementById('copyStatus').innerHTML = '<div class="success">✅ 連結已複製到剪貼簿</div>';
                });
              } else {
                // 降級方案
                const textArea = document.createElement('textarea');
                textArea.value = url;
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
                document.getElementById('copyStatus').innerHTML = '<div class="success">✅ 連結已複製到剪貼簿</div>';
              }
            }
            
            function openInNewWindow() {
              const url = '${currentUrl}';
              try {
                window.open(url, '_blank');
              } catch (e) {
                alert('無法開啟新視窗，請手動複製連結到外部瀏覽器');
              }
            }
            
            // 自動嘗試開啟新視窗（如果可能）
            setTimeout(() => {
              try {
                window.open('${currentUrl}', '_blank');
              } catch (e) {
                // 靜默失敗
              }
            }, 1000);
          </script>
        </body>
        </html>
      `);
    }
    
    // 正常流程
    passport.authenticate('google', { 
      scope: ['profile', 'email'],
      prompt: 'select_account',
      access_type: 'offline',
      include_granted_scopes: true
    })(req, res);
  });

  app.get('/auth/google/callback', 
    passport.authenticate('google', { failureRedirect: '/login' }),
    async function(req, res) {
      // 寫入登入紀錄到 MongoDB Atlas
      if (loginLogsCollection && req.user) {
        try {
          await loginLogsCollection.insertOne({
            email: req.user.email,
            name: req.user.name,
            loginAt: new Date(),
            googleId: req.user.id,
            picture: req.user.picture
          });
          console.log(`[登入紀錄] ${req.user.email} ${req.user.name}`);
        } catch (err) {
          console.error('寫入登入紀錄失敗:', err.message);
        }
      }
      res.redirect('/');
    }
  );
} else {
  // 如果 Google OAuth 未配置，提供友好的錯誤頁面
  app.get('/auth/google', (req, res) => {
    res.status(200).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Google 登入暫時不可用</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            margin: 0;
            padding: 20px;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .container {
            background: white;
            padding: 40px;
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.1);
            text-align: center;
            max-width: 500px;
          }
          .icon {
            font-size: 48px;
            margin-bottom: 20px;
          }
          h1 {
            color: #333;
            margin-bottom: 20px;
          }
          p {
            color: #666;
            line-height: 1.6;
            margin-bottom: 20px;
          }
          .btn {
            background: #4285f4;
            color: white;
            padding: 12px 24px;
            border: none;
            border-radius: 6px;
            text-decoration: none;
            display: inline-block;
            margin: 10px;
            transition: background 0.3s;
          }
          .btn:hover {
            background: #3367d6;
          }
          .btn-secondary {
            background: #6c757d;
          }
          .btn-secondary:hover {
            background: #5a6268;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="icon">🔧</div>
          <h1>Google 登入暫時不可用</h1>
          <p>Google OAuth 功能尚未配置。管理員正在設置中，請稍後再試。</p>
          <p>如果您是管理員，請參考 <code>scripts/setup-google-oauth.md</code> 文件進行設置。</p>
          <a href="/" class="btn">返回首頁</a>
          <a href="/api/health" class="btn btn-secondary">檢查系統狀態</a>
        </div>
      </body>
      </html>
    `);
  });
}

app.get('/auth/logout', function(req, res, next) {
  req.logout(function(err) {
    if (err) { return next(err); }
    res.redirect('/');
  });
});



// 獲取用戶資訊
app.get('/api/user', (req, res) => {
  if (req.isAuthenticated()) {
    res.json({
      success: true,
      user: {
        id: req.user.id,
        email: req.user.email,
        name: req.user.name,
        picture: req.user.picture
      }
    });
  } else {
    res.json({
      success: false,
      user: null
    });
  }
});

// 獲取文件名稱的函數
async function getFileName(fileId, language = 'zh') {
  try {
    const file = await openai.files.retrieve(fileId);
    let fileName = file.filename || `檔案-${fileId.substring(0, 8)}`;
    fileName = fileName.replace(/\.(txt|pdf|docx?|rtf|md)$/i, '');
    
    console.log(`🔍 原始文件名: "${fileName}"`);
    
    // 嘗試從檔案名稱中提取作者名稱並翻譯
    // 支援兩種格式：
    // 1. 開頭格式：Herman Bavinck (1854-1921) Philosophy of Revelation
    // 2. 方括號格式：[Charles Haddon Spurgeon (1834-1892)] Spurgeon's Sermons
    
    let translatedAuthorName = null;
    
    // 檢查方括號格式 [Author Name (Year)] 或 [Author Name]
    const bracketMatch = fileName.match(/\[([^\]\n]+?)\]/);
    if (bracketMatch) {
      const bracketContent = bracketMatch[1].trim();
      console.log(`🔍 方括號格式 - 提取到內容: "${bracketContent}"`);
      
      // 檢查是否包含年份格式 (Year)
      const yearMatch = bracketContent.match(/\(([^)]+)\)/);
      if (yearMatch) {
        // 有年份的格式：[Author Name (Year)]
        const englishAuthorName = bracketContent.replace(/\([^)]+\)/, '').trim();
        console.log(`🔍 方括號格式（有年份）- 提取到作者名稱: "${englishAuthorName}"`);
        
        // 嘗試完整匹配（包含年份）
        const fullNameWithYear = bracketContent;
        let translatedAuthorName = getAuthorName(fullNameWithYear, language);
        console.log(`🔍 方括號完整匹配: "${fullNameWithYear}" -> "${translatedAuthorName}"`);
        
        // 如果完整匹配沒有翻譯，嘗試只匹配作者名（不含年份）
        if (!translatedAuthorName || translatedAuthorName === fullNameWithYear) {
          translatedAuthorName = getAuthorName(englishAuthorName, language);
          console.log(`🔍 方括號部分匹配: "${englishAuthorName}" -> "${translatedAuthorName}"`);
        }
        
        // 如果找到了翻譯，替換檔案名稱
        if (translatedAuthorName && translatedAuthorName !== englishAuthorName) {
          // 替換方括號內的作者名稱，保持年份
          const year = yearMatch[1];
          const originalBracket = `[${bracketContent}]`;
          const translatedBracket = `[${translatedAuthorName} (${year})]`;
          fileName = fileName.replace(originalBracket, translatedBracket);
          console.log(`✅ 方括號翻譯成功: "${originalBracket}" -> "${translatedBracket}"`);
        }
      } else {
        // 沒有年份的格式：[Author Name]
        const englishAuthorName = bracketContent;
        console.log(`🔍 方括號格式（無年份）- 提取到作者名稱: "${englishAuthorName}"`);
        
        const translatedAuthorName = getAuthorName(englishAuthorName, language);
        console.log(`🔍 方括號無年份匹配: "${englishAuthorName}" -> "${translatedAuthorName}"`);
        
        // 如果找到了翻譯，替換檔案名稱
        if (translatedAuthorName && translatedAuthorName !== englishAuthorName) {
          const originalBracket = `[${englishAuthorName}]`;
          const translatedBracket = `[${translatedAuthorName}]`;
          fileName = fileName.replace(originalBracket, translatedBracket);
          console.log(`✅ 方括號翻譯成功: "${originalBracket}" -> "${translatedBracket}"`);
        }
      }
    } else {
      // 檢查開頭格式 Author Name (Year)
      const authorMatch = fileName.match(/^([^(]+?)\s*\(/);
      if (authorMatch) {
        const englishAuthorName = authorMatch[1].trim();
        console.log(`🔍 開頭格式 - 提取到作者名稱: "${englishAuthorName}"`);
        
        // 嘗試完整匹配（包含年份）
        const fullNameWithYear = fileName.match(/^([^(]+?\([^)]+\))/);
        if (fullNameWithYear) {
          translatedAuthorName = getAuthorName(fullNameWithYear[1], language);
          console.log(`🔍 開頭完整匹配: "${fullNameWithYear[1]}" -> "${translatedAuthorName}"`);
        }
        
        // 如果沒有找到，嘗試只匹配作者名（不含年份）
        if (!translatedAuthorName || translatedAuthorName === fullNameWithYear[1]) {
          translatedAuthorName = getAuthorName(englishAuthorName, language);
          console.log(`🔍 開頭部分匹配: "${englishAuthorName}" -> "${translatedAuthorName}"`);
        }
        
        // 如果找到了翻譯，替換檔案名稱
        if (translatedAuthorName && translatedAuthorName !== englishAuthorName) {
          // 替換作者名部分（保持年份不變）
          fileName = fileName.replace(englishAuthorName, translatedAuthorName);
          console.log(`✅ 開頭格式翻譯成功: "${englishAuthorName}" -> "${translatedAuthorName}"`);
        } else if (fullNameWithYear) {
          // 如果完整匹配有翻譯，使用完整匹配的翻譯
          const fullName = fullNameWithYear[1];
          const translatedFullName = getAuthorName(fullName, language);
          if (translatedFullName && translatedFullName !== fullName) {
            // 替換整個完整名稱
            fileName = fileName.replace(fullName, translatedFullName);
            console.log(`✅ 開頭完整翻譯成功: "${fullName}" -> "${translatedFullName}"`);
          }
        }
      }
    }
    
    console.log(`📄 最終文件名: "${fileName}"`);
    return fileName;
  } catch (error) {
    console.warn(`無法獲取檔案名稱 ${fileId}:`, error.message);
    return `檔案-${fileId.substring(0, 8)}`;
  }
}

// 處理引用標記並轉換為網頁格式的函數
async function processAnnotationsInText(text, annotations, language = 'zh') {
  console.log(`🔍 processAnnotationsInText 被調用 - 語言: ${language}`);
  console.log(`📝 原始文本長度: ${text.length}`);
  console.log(`📝 註解數量: ${annotations ? annotations.length : 0}`);
  
  let processedText = text;
  const sourceMap = new Map();
  const usedSources = new Map();
  let citationCounter = 1;
  
  if (annotations && annotations.length > 0) {
    // 並行預處理所有檔案名稱
    const fileProcessingPromises = [];
    const annotationMap = new Map();
    
    for (const annotation of annotations) {
      if (annotation.type === 'file_citation' && annotation.file_citation) {
        const fileId = annotation.file_citation.file_id;
        const quote = annotation.file_citation.quote || '';
        
        // 並行處理檔案名稱
        const fileNamePromise = getFileName(fileId, language);
        fileProcessingPromises.push(fileNamePromise);
        annotationMap.set(annotation, { fileId, quote, fileNamePromise });
      }
    }
    
    // 等待所有檔案名稱處理完成
    const fileNames = await Promise.all(fileProcessingPromises);
    let fileNameIndex = 0;
    
    for (const annotation of annotations) {
      if (annotation.type === 'file_citation' && annotation.file_citation) {
        const { fileId, quote } = annotationMap.get(annotation);
        const fileName = fileNames[fileNameIndex++];
        
        let citationIndex;
        if (usedSources.has(fileId)) {
          citationIndex = usedSources.get(fileId);
        } else {
          citationIndex = citationCounter++;
          usedSources.set(fileId, citationIndex);
          sourceMap.set(citationIndex, {
            fileName,
            quote,
            fileId
          });
        }
        
        const originalText = annotation.text;
        console.log(`📄 處理註解 ${citationCounter}: "${originalText}"`);
        
        if (originalText) {
          // 嘗試翻譯註解文本中的作者名稱
          let translatedText = originalText;
          
          // 檢查是否包含作者名稱格式 [Author Name (Year)]
          const authorMatch = originalText.match(/\[([^(]+?)\s*\([^)]+\)\]/);
          if (authorMatch) {
            const fullAuthorName = authorMatch[1].trim();
            
            // 嘗試多種匹配方式來找到翻譯
            let translatedAuthorName = null;
            
            // 1. 嘗試完整匹配（包含年份）
            const fullNameWithYear = originalText.match(/\[([^(]+?\([^)]+\))\]/);
            if (fullNameWithYear) {
              translatedAuthorName = getAuthorName(fullNameWithYear[1], language);
            }
            
            // 2. 如果沒有找到，嘗試只匹配作者名（不含年份）
            if (!translatedAuthorName || translatedAuthorName === fullNameWithYear[1]) {
              translatedAuthorName = getAuthorName(fullAuthorName, language);
            }
            
            if (translatedAuthorName && translatedAuthorName !== fullAuthorName) {
              // 替換作者名稱，保持年份和格式
              translatedText = originalText.replace(fullAuthorName, translatedAuthorName);
              console.log(`✅ 部分翻譯成功: "${originalText}" -> "${translatedText}"`);
            } else if (fullNameWithYear) {
              // 如果完整匹配有翻譯，使用完整匹配的翻譯
              const fullName = fullNameWithYear[1];
              const translatedFullName = getAuthorName(fullName, language);
              if (translatedFullName && translatedFullName !== fullName) {
                // 替換整個完整名稱，但保持年份格式
                const yearMatch = fullName.match(/\(([^)]+)\)/);
                if (yearMatch) {
                  const year = yearMatch[1];
                  const translatedWithYear = `${translatedFullName} (${year})`;
                  translatedText = originalText.replace(fullName, translatedWithYear);
                  console.log(`✅ 完整翻譯成功: "${originalText}" -> "${translatedText}"`);
                } else {
                  translatedText = originalText.replace(fullName, translatedFullName);
                  console.log(`✅ 翻譯成功: "${originalText}" -> "${translatedText}"`);
                }
              }
            }
          }
          
          // 檢查 Railway 格式的註解 【4:7†source】
          const railwayMatch = originalText.match(/【([^】]+?)】/);
          if (railwayMatch) {
            console.log(`🔍 發現 Railway 格式註解: "${railwayMatch[1]}"`);
            // Railway 格式的註解不需要翻譯，直接使用
            translatedText = originalText;
          }
          
          const replacement = `${translatedText}[${citationIndex}]`;
          console.log(`📄 最終替換: "${originalText}" -> "${replacement}"`);
          processedText = processedText.replace(originalText, replacement);
        }
      }
    }
    
    // 清理格式問題並改善排版
    processedText = processedText
      .replace(/【[^】]*】/g, '')
      .replace(/†[^†\s]*†?/g, '')
      .replace(/,\s*\n/g, '\n')
      .replace(/,\s*$/, '')
      .replace(/\n\s*,/g, '\n')
      .replace(/(\[\d+\])(\[\d+\])*\1+/g, '$1$2')
      .replace(/(\[\d+\])+/g, (match) => {
        const citations = match.match(/\[\d+\]/g);
        const uniqueCitations = [...new Set(citations)];
        return uniqueCitations.join('');
      })
      .replace(/(\d+)\.\s*([^：。！？\n]+[：])/g, '\n\n**$1. $2**\n')
      .replace(/([。！？])\s+(\d+\.)/g, '$1\n\n**$2')
      .replace(/([。！？])\s*([A-Za-z][^。！？]*：)/g, '$1\n\n**$2**\n')
      .replace(/\*\s*([^*\n]+)\s*：\s*\*/g, '**$1：**')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/g, '')
      .replace(/([。！？])(?=\s*(?!\*\*\d+\.)[^\n])/g, '$1\n\n')
      .trim();
  }
  
  return { processedText, sourceMap };
}

// 創建來源列表的函數
function createSourceList(sourceMap) {
  if (sourceMap.size === 0) return '';
  
  let sourceList = '\n\n📚 **引用來源：**\n';
  
  // 按照編號順序排列
  const sortedSources = Array.from(sourceMap.entries()).sort((a, b) => a[0] - b[0]);
  
  sortedSources.forEach(([index, source]) => {
    sourceList += `**[${index}]** ${source.fileName}`;
    if (source.quote && source.quote.length > 0) {
      // 顯示引用片段（限制長度）
      const shortQuote = source.quote.length > 120 
        ? source.quote.substring(0, 120) + '...' 
        : source.quote;
      sourceList += `\n    └ *"${shortQuote}"*`;
    }
    sourceList += '\n';
  });
  
  return sourceList;
}

// 簡單的快取機制
const searchCache = new Map();

// 獲取快取結果
function getCachedResult(question) {
    const key = question.toLowerCase().trim();
    const cached = searchCache.get(key);
    
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        console.log('✅ 使用快取結果');
        return cached.result;
    }
    return null;
}

// 設置快取結果
function setCachedResult(question, result) {
    const key = question.toLowerCase().trim();
    searchCache.set(key, {
        result: result,
        timestamp: Date.now()
    });
    console.log('💾 結果已快取');
    
    // 清理過期的快取（保持記憶體使用合理）
    if (searchCache.size > 100) {
        const now = Date.now();
        for (const [key, value] of searchCache.entries()) {
            if (now - value.timestamp > CACHE_DURATION) {
                searchCache.delete(key);
            }
        }
    }
}

// 獲取或創建 Assistant
async function getOrCreateAssistant() {
    if (!globalAssistant) {
        console.log('🔄 創建全局 Assistant...');
        
        // 檢查是否有向量資料庫 ID
        const vectorStoreId = process.env.VECTOR_STORE_ID;
        
        // 重試機制 - 最多重試 3 次
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                if (!vectorStoreId) {
                    console.log('⚠️ 未設置 VECTOR_STORE_ID，創建不帶文件搜索的 Assistant');
                    globalAssistant = await openai.beta.assistants.create({
                        model: 'gpt-4o-mini',
                        name: 'Theology Assistant (No File Search)',
                        instructions: `你是一個專業的神學助手。

重要規則：
1. 回答要準確、簡潔且有幫助
2. 使用繁體中文回答
3. 專注於提供基於神學知識的準確資訊
4. 如果沒有相關資訊，請明確說明

格式要求：
- 直接回答問題內容
- 不需要在回答中手動添加資料來源`
                    });
                } else {
                    globalAssistant = await openai.beta.assistants.create({
                        model: 'gpt-4o-mini',
                        name: 'Theology RAG Assistant',
                        instructions: `你是一個專業的神學助手，只能根據提供的知識庫資料來回答問題。

重要規則：
1. 只使用檢索到的資料來回答問題
2. 如果資料庫中沒有相關資訊，請明確說明「很抱歉，我在資料庫中找不到相關資訊來回答這個問題，因為資料庫都為英文，建議將專有名詞替換成英文或許會有幫助」
3. 回答要準確、簡潔且有幫助
4. 使用繁體中文回答
5. 專注於提供基於資料庫內容的準確資訊
6. 盡可能引用具體的資料片段

格式要求：
- 直接回答問題內容
- 引用相關的資料片段（如果有的話）
- 不需要在回答中手動添加資料來源，系統會自動處理`,
                        tools: [{ type: 'file_search' }],
                        tool_resources: {
                            file_search: {
                                vector_store_ids: [vectorStoreId]
                            }
                        }
                    });
                }
                
                console.log(`✅ 全局 Assistant 創建成功 (嘗試 ${attempt}/3)`);
                break; // 成功創建，跳出重試循環
                
            } catch (error) {
                console.warn(`⚠️ Assistant 創建失敗 (嘗試 ${attempt}/3):`, error.message);
                
                if (attempt === 3) {
                    // 最後一次嘗試失敗，拋出錯誤
                    console.error('❌ Assistant 創建最終失敗，將使用備用方案');
                    throw new Error(`Assistant 創建失敗: ${error.message}`);
                }
                
                // 等待後重試
                const delay = Math.min(1000 * attempt, 3000); // 指數退避，最大 3 秒
                console.log(`⏳ 等待 ${delay}ms 後重試...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    
    // 驗證 Assistant 是否可用（額外的穩定性檢查）
    try {
        await openai.beta.assistants.retrieve(globalAssistant.id);
        return globalAssistant;
    } catch (error) {
        console.warn('⚠️ Assistant 驗證失敗，重新創建:', error.message);
        globalAssistant = null; // 重置，強制重新創建
        return await getOrCreateAssistant(); // 遞歸調用重新創建
    }
}

// OpenAI Assistant API 處理（加入 Google Sheets 紀錄）
async function processSearchRequest(question, user, language = 'zh') {
    console.log('🔄 使用 OpenAI Assistant API 方法...');
    
    const cachedResult = getCachedResult(question);
    if (cachedResult) {
        return cachedResult;
    }
    
    const requestKey = question.toLowerCase().trim();
    if (processingRequests.has(requestKey)) {
        console.log('⏳ 相同請求正在處理中，等待結果...');
        return processingRequests.get(requestKey);
    }
    
    const processingPromise = (async () => {
        try {
            const result = await processSearchRequestInternal(question, user, language);
            try {
                const userName = user?.name || '';
                const userEmail = user?.email || '';
                const timestamp = new Date().toISOString();
                const q = question;
                const a = result?.answer || '';
                await appendToGoogleSheet([timestamp, language, userName, userEmail, q, a]);
            } catch (e) {
                console.warn('⚠️ 問答寫入表單失敗（不影響回應）:', e.message);
            }
            return result;
        } finally {
            processingRequests.delete(requestKey);
        }
    })();
    
    processingRequests.set(requestKey, processingPromise);
    
    return processingPromise;
}

// 實際的搜索處理邏輯
async function processSearchRequestInternal(question, user, language = 'zh') {
    
    try {
        // 使用全局 Assistant（重用機制）
        const assistant = await getOrCreateAssistant();
        console.log('✅ 使用現有 Assistant');

        // 創建 Thread
        const thread = await openai.beta.threads.create();
        console.log('✅ Thread 創建成功');

        // 添加用戶問題到 Thread
        await openai.beta.threads.messages.create(thread.id, {
            role: "user",
            content: question
        });

        // 創建 Run
        const run = await openai.beta.threads.runs.create(thread.id, {
            assistant_id: assistant.id
        });
        console.log('✅ Run 創建成功，等待處理...');

        // 延遲起始輪詢 - 預估等待再查
        console.log('⏳ 預估等待 3 秒後開始檢查狀態...');
        await new Promise(resolve => setTimeout(resolve, 3000));

        // 等待完成 - 超優化版等待機制
        let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
        let attempts = 0;
        const maxAttempts = 60; // 60 秒超時
        const initialDelay = 200; // 更激進的初始延遲 200ms
        const maxDelay = 2000; // 降低最大延遲到 2 秒
        let lastStatus = runStatus.status;

        while (runStatus.status !== 'completed' && runStatus.status !== 'failed' && attempts < maxAttempts) {
            // 檢查是否需要處理工具調用
            if (runStatus.status === 'requires_action') {
                console.log('🔧 檢測到工具調用需求，立即處理...');
                
                // 處理工具調用
                const toolOutputs = [];
                for (const toolCall of runStatus.required_action.submit_tool_outputs.tool_calls) {
                    if (toolCall.function.name === 'retrieval') {
                        // 文件搜索工具調用
                        toolOutputs.push({
                            tool_call_id: toolCall.id,
                            output: "文件搜索已完成"
                        });
                    }
                }
                
                // 提交工具輸出
                runStatus = await openai.beta.threads.runs.submitToolOutputs(
                    thread.id,
                    run.id,
                    { tool_outputs: toolOutputs }
                );
                console.log('✅ 工具調用處理完成');
                attempts++;
                continue;
            }
            
            // 智能延遲策略
            let delay;
            if (attempts < 3) {
                // 前 3 次快速檢查
                delay = 200;
            } else if (attempts < 10) {
                // 中等頻率檢查
                delay = Math.min(initialDelay * Math.pow(1.1, attempts - 3), 1000);
            } else {
                // 後期較慢檢查
                delay = Math.min(initialDelay * Math.pow(1.2, attempts), maxDelay);
            }
            
            await new Promise(resolve => setTimeout(resolve, delay));
            
            runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
            attempts++;
            
            // 智能日誌：只在狀態變化或關鍵時刻記錄
            if (runStatus.status !== lastStatus || attempts % 8 === 0 || attempts <= 3) {
                console.log(`⏳ 處理中... 嘗試次數: ${attempts}, 狀態: ${runStatus.status}`);
                lastStatus = runStatus.status;
            }
        }

        if (runStatus.status === 'failed') {
            throw new Error(`Assistant run failed: ${runStatus.last_error?.message || 'Unknown error'}`);
        }

        if (attempts >= maxAttempts) {
            throw new Error('查詢時間過長，請嘗試簡化您的問題或稍後再試');
        }

        console.log(`📊 Run 狀態: ${runStatus.status}`);
        console.log(`🔧 Assistant ID: ${assistant.id}`);
        console.log(`💾 向量資料庫 ID: ${process.env.VECTOR_STORE_ID}`);

        // 獲取回答
        const messages = await openai.beta.threads.messages.list(thread.id);
        const lastMessage = messages.data[0]; // 最新的消息是 Assistant 的回答
        
        if (!lastMessage || lastMessage.role !== 'assistant') {
            throw new Error('無法獲取 Assistant 回答');
        }

        const answer = lastMessage.content[0].text.value;
        console.log('✅ 成功獲取 Assistant 回答');

        // 並行處理註解和翻譯
        const annotations = lastMessage.content[0].text.annotations;
        let { processedText, sourceMap } = await processAnnotationsInText(
            answer, 
            annotations,
            language
        );

        // 不清理 Assistant，保持重用
        console.log('✅ Assistant 重用完成');
        
        // 組合最終回答
        let finalAnswer = processedText;

        // 如果沒有獲取到回答
        if (!finalAnswer || finalAnswer.trim() === '') {
            finalAnswer = '很抱歉，我在資料庫中找不到相關資訊來回答這個問題。';
        }

        const result = {
            question: question,
            answer: finalAnswer,
            sources: Array.from(sourceMap.entries()).map(([index, source]) => ({
                index,
                fileName: source.fileName,
                quote: source.quote && source.quote.length > 120 
                    ? source.quote.substring(0, 120) + '...' 
                    : source.quote,
                fileId: source.fileId
            })),
            timestamp: new Date().toISOString(),
            user: user,
            method: 'Assistant API'
        };

        // 設置快取
        setCachedResult(question, result);

        return result;

    } catch (error) {
        console.error('❌ Assistant API 處理失敗:', error.message);
        throw error;
    }
}

// 移動設備連線檢查端點
app.get('/api/mobile-check', (req, res) => {
  res.json({
    success: true,
    message: '移動設備連線正常',
    timestamp: new Date().toISOString(),
    userAgent: req.headers['user-agent'],
    sessionId: req.sessionID
  });
});

// 測試搜索 API 端點 - 不需要認證（僅用於調試）
app.post('/api/test-search', async (req, res) => {
  try {
    const { question, language = 'zh' } = req.body;

    if (!question || !question.trim()) {
      return res.status(400).json({
        success: false,
        error: '請提供有效的問題'
      });
    }

    const trimmedQuestion = question.trim();
    console.log(`收到測試搜索請求: ${trimmedQuestion} (語言: ${language})`);

    // 模擬用戶對象
    const mockUser = { email: 'test@example.com' };

    // 使用 OpenAI Assistant API
    const result = await processSearchRequest(trimmedQuestion, mockUser, language);

    console.log('測試搜索處理完成，返回結果:', JSON.stringify(result, null, 2));

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('測試搜索錯誤:', error);
    
    let errorMessage = '很抱歉，處理您的問題時發生錯誤，請稍後再試。';
    
    if (error.message.includes('查詢時間過長') || error.message.includes('timeout')) {
      errorMessage = '查詢時間過長，請嘗試簡化您的問題或稍後再試。';
    } else if (error.message.includes('rate limit')) {
      errorMessage = '目前請求過多，請稍後再試。';
    } else if (error.message.includes('Assistant run failed')) {
      errorMessage = '系統處理問題，請稍後再試或聯繫管理員。';
    } else if (error.message.includes('network') || error.message.includes('connection')) {
      errorMessage = '網路連線不穩定，請檢查網路後重試。';
    }
    
    res.status(500).json({
      success: false,
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      retry: true
    });
  }
});



// 主要搜索 API 端點 - 支援未登入訪客（可透過 REQUIRE_AUTH 控制）
app.post('/api/search', async (req, res) => {
  try {
    const { question, language = 'zh' } = req.body;

    if (!question || !question.trim()) {
      return res.status(400).json({
        success: false,
        error: '請提供有效的問題'
      });
    }

    const trimmedQuestion = question.trim();

    const isAuthenticated = typeof req.isAuthenticated === 'function' ? req.isAuthenticated() : false;
    const requireAuth = process.env.REQUIRE_AUTH === 'true';

    if (!isAuthenticated && requireAuth) {
      return res.status(401).json({
        success: false,
        error: '需要登入才能使用此功能',
        requiresAuth: true
      });
    }

    const userForProcessing = isAuthenticated && req.user ? req.user : { email: 'guest@anonymous' };
    const userEmailForLog = userForProcessing && userForProcessing.email ? userForProcessing.email : 'guest@anonymous';

    console.log(`收到搜索請求: ${trimmedQuestion} (用戶: ${userEmailForLog}, 語言: ${language})`);

    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const result = await processSearchRequest(trimmedQuestion, userForProcessing, language);

    console.log('搜索處理完成，返回結果:', JSON.stringify(result, null, 2));

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('搜索錯誤:', error);
    
    let errorMessage = '很抱歉，處理您的問題時發生錯誤，請稍後再試。';
    
    if (error.message.includes('查詢時間過長') || error.message.includes('timeout')) {
      errorMessage = '查詢時間過長，請嘗試簡化您的問題或稍後再試。';
    } else if (error.message.includes('rate limit')) {
      errorMessage = '目前請求過多，請稍後再試。';
    } else if (error.message.includes('Assistant run failed')) {
      errorMessage = '系統處理問題，請稍後再試或聯繫管理員。';
    } else if (error.message.includes('network') || error.message.includes('connection')) {
      errorMessage = '網路連線不穩定，請檢查網路後重試。';
    }
    
    res.status(500).json({
      success: false,
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      retry: true // 建議前端重試
    });
  }
});

// 作者對照表 API（必須在靜態文件服務之前）
app.get('/config/author-translations.json', (req, res) => {
  try {
    const translationsPath = path.join(__dirname, 'config', 'author-translations.json');
    if (fs.existsSync(translationsPath)) {
      const data = fs.readFileSync(translationsPath, 'utf8');
      res.setHeader('Content-Type', 'application/json');
      res.send(data);
    } else {
      res.status(404).json({ success: false, error: '作者對照表不存在' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: '無法讀取作者對照表' });
  }
});

// 作品目錄 API
app.get('/api/catalog', (req, res) => {
  try {
    const catalog = fs.readFileSync(path.join(__dirname, 'public', 'ccel_catalog.json'), 'utf8');
    res.setHeader('Content-Type', 'application/json');
    res.send(catalog);
  } catch (err) {
    res.status(500).json({ success: false, error: '無法讀取作品目錄' });
  }
});

// 新增：FHL 聖經 JSON 代理端點（qb.php）
app.get('/api/bible/qb', async (req, res) => {
  try {
    const upstreamBase = 'https://bible.fhl.net/json/qb.php';

    // 保留所有查詢參數並轉發
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (value !== undefined && value !== null) {
        params.append(key, String(value));
      }
    }

    // 若無參考字串，回覆錯誤
    if (!params.has('chineses') && !params.has('engs')) {
      return res.status(400).json({ success: false, error: '缺少經文參考（chineses 或 engs）' });
    }

    // 給定預設版本（和合本）
    if (!params.has('version')) {
      params.set('version', 'unv');
    }

    // 預設限制避免過大回應
    if (!params.has('limit')) {
      params.set('limit', '200');
    }

    const upstreamUrl = `${upstreamBase}?${params.toString()}`;

    const response = await fetch(upstreamUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ success: false, error: '上游服務錯誤', details: text.slice(0, 500) });
    }

    const data = await response.json();
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data });
  } catch (err) {
    console.error('FHL 代理錯誤:', err);
    res.status(500).json({ success: false, error: 'FHL 代理請求失敗' });
  }
});

// 新增：bolls.life 聖經章節代理端點
app.get('/api/bible/chapter', async (req, res) => {
  try {
    const translation = (req.query.translation || 'CUV').toString().toUpperCase();
    const bookId = parseInt(req.query.bookId, 10);
    const chapter = parseInt(req.query.chapter, 10);
    if (!bookId || !chapter) {
      return res.status(400).json({ success: false, error: '缺少必要參數 bookId 或 chapter' });
    }

    const upstreamUrl = `https://bolls.life/get-text/${encodeURIComponent(translation)}/${bookId}/${chapter}/`;
    const response = await fetch(upstreamUrl, { headers: { 'Accept': 'application/json' } });
    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ success: false, error: '上游服務錯誤', details: text.slice(0, 500) });
    }
    const data = await response.json();
    // 期待 data 為 verses 陣列
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data });
  } catch (err) {
    console.error('bolls 代理錯誤:', err);
    res.status(500).json({ success: false, error: 'bolls 代理請求失敗' });
  }
});

// 健康檢查端點
app.get('/api/health', (req, res) => {
  const healthStatus = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    port: process.env.PORT || 3000,
    services: {
      openai: !!process.env.OPENAI_API_KEY,
      vectorStore: !!process.env.VECTOR_STORE_ID,
      googleOAuth: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      mongodb: !!process.env.MONGO_URI,
      session: !!process.env.SESSION_SECRET
    }
  };
  
  // 檢查關鍵服務是否可用
  const criticalServices = ['openai', 'vectorStore', 'session'];
  const missingServices = criticalServices.filter(service => !healthStatus.services[service]);
  
  if (missingServices.length > 0) {
    healthStatus.status = 'warning';
    healthStatus.warnings = `缺少關鍵服務: ${missingServices.join(', ')}`;
  }
  
  res.json(healthStatus);
});

// 獲取系統資訊端點
app.get('/api/info', (req, res) => {
  res.json({
    name: '神學知識庫 API',
    version: '1.0.0',
    description: '基於 OpenAI 向量搜索的神學問答系統',
    vectorStoreId: VECTOR_STORE_ID ? 'configured' : 'not configured',
    googleOAuth: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    method: 'OpenAI Assistant API'
  });
});

// Robots.txt and sitemap.xml
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.send(`User-agent: *\nAllow: /\n\nSitemap: ${base.replace(/\/$/, '')}/sitemap.xml\n`);
});

app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${base.replace(/\/$/, '')}/</loc>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>\n</urlset>`;
  res.send(xml);
});

// Serve index.html with dynamic canonical, OG url, GA4 and GSC meta
app.get('/', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'index.html');
  try {
    let html = fs.readFileSync(filePath, 'utf8');
    const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    if (base) {
      html = html.replace(/https:\/\/your-domain\.example/g, base.replace(/\/$/, ''));
    }
    // Inject GSC verification if present
    if (process.env.GOOGLE_SITE_VERIFICATION) {
      html = html.replace('</head>', `  <meta name="google-site-verification" content="${process.env.GOOGLE_SITE_VERIFICATION}">\n</head>`);
    }
    // Inject GA4 if present
    if (process.env.GA_MEASUREMENT_ID) {
      const gtag = `\n<script async src="https://www.googletagmanager.com/gtag/js?id=${process.env.GA_MEASUREMENT_ID}"></script>\n<script>\nwindow.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js', new Date());gtag('config','${process.env.GA_MEASUREMENT_ID}');\n</script>\n`;
      html = html.replace('</head>', `${gtag}</head>`);
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.sendFile(filePath);
  }
});

// 服務靜態文件
app.use(express.static(path.join(__dirname, 'public')));

// 錯誤處理中間件
app.use((error, req, res, next) => {
  console.error('未處理的錯誤:', error);
  res.status(500).json({
    success: false,
    error: '服務器內部錯誤',
    details: process.env.NODE_ENV === 'development' ? error.message : undefined
  });
});

// 404 處理
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: '找不到請求的資源'
  });
});

// 全局錯誤處理
process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

// 優雅關閉處理
process.on('SIGTERM', () => {
  console.log('🛑 收到 SIGTERM 信號，開始優雅關閉...');
  stopPeriodicWarmup();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 收到 SIGINT 信號，開始優雅關閉...');
  stopPeriodicWarmup();
  process.exit(0);
});

// 積極的 Assistant 預熱功能
async function performActiveWarmup() {
    try {
        console.log('🔥 執行積極預熱 - 發送測試問題...');
        
        // 獲取或創建 Assistant
        const assistant = await getOrCreateAssistant();
        
        // 創建 Thread
        const thread = await openai.beta.threads.create();
        
        // 發送一個簡單的測試問題
        await openai.beta.threads.messages.create(thread.id, {
            role: "user",
            content: "你好，請簡單介紹一下神學"
        });
        
        // 創建 Run
        const run = await openai.beta.threads.runs.create(thread.id, {
            assistant_id: assistant.id
        });
        
        // 等待完成
        let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
        let attempts = 0;
        const maxAttempts = 30; // 30 秒超時
        
        while (runStatus.status !== 'completed' && runStatus.status !== 'failed' && attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
            attempts++;
        }
        
        if (runStatus.status === 'completed') {
            console.log('✅ 積極預熱完成 - Assistant 已完全初始化');
        } else {
            console.warn('⚠️ 積極預熱未完全完成，但 Assistant 已可用');
        }
        
    } catch (error) {
        console.warn('⚠️ 積極預熱失敗:', error.message);
    }
}

// 定期保溫機制
function startPeriodicWarmup() {
    // 每 10 分鐘執行一次保溫
    const WARMUP_INTERVAL = 10 * 60 * 1000; // 10 分鐘
    
    assistantWarmupInterval = setInterval(async () => {
        try {
            console.log('🔥 執行定期保溫...');
            
            // 簡單的 ping 操作
            const assistant = await getOrCreateAssistant();
            await openai.beta.assistants.retrieve(assistant.id);
            
            console.log('✅ 定期保溫完成');
        } catch (error) {
            console.warn('⚠️ 定期保溫失敗:', error.message);
        }
    }, WARMUP_INTERVAL);
    
    console.log(`🔄 定期保溫已啟動 (每 ${WARMUP_INTERVAL / 60000} 分鐘)`);
}

// 停止定期保溫
function stopPeriodicWarmup() {
    if (assistantWarmupInterval) {
        clearInterval(assistantWarmupInterval);
        assistantWarmupInterval = null;
        console.log('🛑 定期保溫已停止');
    }
}

async function appendToGoogleSheet(rowValues) {
  try {
    const { GOOGLE_SHEETS_SPREADSHEET_ID, GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY } = process.env;
    if (!GOOGLE_SHEETS_SPREADSHEET_ID || !GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY) {
      console.warn('⚠️ Google Sheets 環境變數未完整，略過寫入');
      return;
    }
    const jwt = new google.auth.JWT(
      GOOGLE_CLIENT_EMAIL,
      null,
      GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.file'
      ]
    );
    await jwt.authorize();
    const sheets = google.sheets({ version: 'v4', auth: jwt });
    const now = new Date();
    const values = [rowValues];
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_SPREADSHEET_ID,
      range: 'A:Z',
      valueInputOption: 'RAW',
      requestBody: { values }
    });
    console.log('✅ 已寫入 Google Sheet');
  } catch (err) {
    console.error('❌ 寫入 Google Sheet 失敗:', err.message);
  }
}

// 啟動服務器
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 神學知識庫服務器已啟動`);
  console.log(`📍 端口: ${PORT}`);
  console.log(`🔍 API 健康檢查: /api/health`);
  console.log(`📊 系統狀態: /api/info`);
  console.log(`💡 向量資料庫 ID: ${VECTOR_STORE_ID ? '已設定' : '未設定'}`);
  console.log(`🔐 Google OAuth: ${process.env.GOOGLE_CLIENT_ID ? '已設定' : '未設定'}`);
  console.log(`🤖 使用 OpenAI Assistant API 模式`);
  
  // 載入作者對照表
  await loadAuthorTranslations();
  
  // 積極預熱 Assistant（冷啟動改善）
  setTimeout(async () => {
    try {
      console.log('🔥 開始積極預熱 Assistant...');
      
      // 執行積極預熱（發送測試問題）
      await performActiveWarmup();
      
      // 啟動定期保溫機制
      startPeriodicWarmup();
      
    } catch (error) {
      console.warn('⚠️ Assistant 積極預熱失敗:', error.message);
    }
  }, 2000); // 2秒後開始積極預熱
  
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.log(`⚠️  注意: Google OAuth 未配置，登入功能將不可用`);
    console.log(`   請設置 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET 環境變數`);
  }
  
  if (!process.env.VECTOR_STORE_ID) {
    console.log(`⚠️  注意: VECTOR_STORE_ID 未配置，向量搜索功能將不可用`);
    console.log(`   請設置 VECTOR_STORE_ID 環境變數`);
  }
});
