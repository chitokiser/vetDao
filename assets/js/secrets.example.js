// assets/js/secrets.example.js
// 이 파일을 복사해서 secrets.js 를 만들고 실제 키를 입력하세요.
// cp assets/js/secrets.example.js assets/js/secrets.js

window.SECRETS = {
  firebase: {
    apiKey:            "YOUR_FIREBASE_API_KEY",
    authDomain:        "YOUR_PROJECT.firebaseapp.com",
    projectId:         "YOUR_PROJECT",
    storageBucket:     "YOUR_PROJECT.firebasestorage.app",
    messagingSenderId: "YOUR_SENDER_ID",
    appId:             "YOUR_APP_ID",
  },
  jump: {
    apiKey:            "YOUR_JUMP_API_KEY",
    apiUrl:            "https://us-central1-YOUR_PROJECT.cloudfunctions.net/externalApi",
    firebase: {
      apiKey:            "YOUR_JUMP_FIREBASE_API_KEY",
      authDomain:        "YOUR_JUMP_PROJECT.firebaseapp.com",
      projectId:         "YOUR_JUMP_PROJECT",
      storageBucket:     "YOUR_JUMP_PROJECT.firebasestorage.app",
      messagingSenderId: "YOUR_JUMP_SENDER_ID",
      appId:             "YOUR_JUMP_APP_ID",
      measurementId:     "YOUR_MEASUREMENT_ID",
    },
  },
};
