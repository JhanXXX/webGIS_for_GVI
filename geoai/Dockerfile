# Optimized Dockerfile for VS Code Dev Containers
FROM mcr.microsoft.com/vscode/devcontainers/python:3.10

# Install system dependencies for geospatial packages
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get -y install --no-install-recommends \
        gdal-bin \
        libgdal-dev \
        libproj-dev \
        libgeos-dev \
        libspatialindex-dev \
        build-essential \
        curl \
        wget \
        git \
        htop \
        tree \
    && apt-get autoremove -y && apt-get clean -y && rm -rf /var/lib/apt/lists/*

# Set GDAL environment variables
ENV CPLUS_INCLUDE_PATH=/usr/include/gdal \
    C_INCLUDE_PATH=/usr/include/gdal \
    GDAL_DATA=/usr/share/gdal
    
# Set work directory
WORKDIR /app

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app/ ./app/
COPY models/ ./models/
COPY tests/ ./tests/

# Create logs directory
RUN mkdir -p logs

# Expose port
EXPOSE 8000

# Command to run the application
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]