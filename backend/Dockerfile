FROM node:18-alpine

# 安装必要的系统依赖
RUN apk add --no-cache postgresql-client curl

# 设置工作目录
WORKDIR /app

# 复制package文件
COPY package*.json ./

# 安装依赖
RUN npm install

# 复制源码
COPY src/ ./src/

# 创建日志目录
RUN mkdir -p logs

# 暴露端口
EXPOSE 8080

# 启动命令
CMD ["npm", "start"]