// Netlify 빌드 시 환경변수로 secrets.js 자동 생성
const fs = require('fs');

const required = [
  'FIREBASE_API_KEY', 'FIREBASE_AUTH_DOMAIN', 'FIREBASE_PROJECT_ID',
  'FIREBASE_STORAGE_BUCKET', 'FIREBASE_MESSAGING_SENDER_ID', 'FIREBASE_APP_ID',
  'JUMP_API_KEY', 'JUMP_API_URL',
  'JUMP_FB_API_KEY', 'JUMP_FB_AUTH_DOMAIN', 'JUMP_FB_PROJECT_ID',
  'JUMP_FB_STORAGE_BUCKET', 'JUMP_FB_MESSAGING_SENDER_ID', 'JUMP_FB_APP_ID', 'JUMP_FB_MEASUREMENT_ID',
];

const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌ Netlify 환경변수 누락:', missing.join(', '));
  process.exit(1);
}

const content = `// 자동 생성 파일 — 수정 금지 (generate-secrets.js 가 생성함)
window.SECRETS = {
  firebase: {
    apiKey:            "${process.env.FIREBASE_API_KEY}",
    authDomain:        "${process.env.FIREBASE_AUTH_DOMAIN}",
    projectId:         "${process.env.FIREBASE_PROJECT_ID}",
    storageBucket:     "${process.env.FIREBASE_STORAGE_BUCKET}",
    messagingSenderId: "${process.env.FIREBASE_MESSAGING_SENDER_ID}",
    appId:             "${process.env.FIREBASE_APP_ID}",
  },
  jump: {
    apiKey: "${process.env.JUMP_API_KEY}",
    apiUrl: "${process.env.JUMP_API_URL}",
    firebase: {
      apiKey:            "${process.env.JUMP_FB_API_KEY}",
      authDomain:        "${process.env.JUMP_FB_AUTH_DOMAIN}",
      projectId:         "${process.env.JUMP_FB_PROJECT_ID}",
      storageBucket:     "${process.env.JUMP_FB_STORAGE_BUCKET}",
      messagingSenderId: "${process.env.JUMP_FB_MESSAGING_SENDER_ID}",
      appId:             "${process.env.JUMP_FB_APP_ID}",
      measurementId:     "${process.env.JUMP_FB_MEASUREMENT_ID}",
    },
  },
};
`;

fs.writeFileSync('assets/js/secrets.js', content);
console.log('✅ secrets.js 생성 완료');
