import { initializeApp } from 'firebase/app'
import { getDatabase } from 'firebase/database'
import { getAuth } from 'firebase/auth'

const app = initializeApp({
  apiKey: 'AIzaSyAWaMhAj8t3Hcyeeerhk0wHsaCNMLsDrTk',
  authDomain: 'esp32-dab34.firebaseapp.com',
  databaseURL: 'https://esp32-dab34-default-rtdb.firebaseio.com',
  projectId: 'esp32-dab34',
})
export const db = getDatabase(app)
export const auth = getAuth(app)
