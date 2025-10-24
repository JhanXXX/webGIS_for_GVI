const express = require('express');
const cors = require('cors');
const planningRoutes = require('./routes/planning_api');

const app = express();
const PORT = process.env.PORT || 8080;

// 中间件
app.use(cors());
app.use(express.json());

// 路由
app.get('/', (req, res) => {
    res.json({
        service: 'GVI Routing Backend',
        status: 'running',
        version: '1.0.0'
    });
});

app.use('/api/v1', planningRoutes);

// 错误处理
app.use((error, req, res, next) => {
    console.error('Error:', error.message);
    res.status(500).json({
        error: 'Internal Server Error',
        message: error.message
    });
});

const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

module.exports = app;