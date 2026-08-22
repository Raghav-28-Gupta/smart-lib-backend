import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { healthRouter } from './routes/health'

const app = express()
app.use(cors())
app.use(express.json())
app.use(healthRouter)

const PORT = process.env.PORT ?? 3000
app.listen(PORT, () => console.log(`Node backend running on port ${PORT}`))
