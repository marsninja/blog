FROM python:3.12-slim# Build stage

FROM python:3.11-slim as builder

# Install system dependencies

RUN apt-get update && apt-get install -y \# Set working directory

    curl \WORKDIR /app

    && rm -rf /var/lib/apt/lists/*

# Install build dependencies

# Set working directoryRUN apt-get update && apt-get install -y --no-install-recommends \

WORKDIR /app    git \

    && rm -rf /var/lib/apt/lists/*

# Copy documentation files

COPY docs/ ./docs/# Copy requirements

COPY scripts/ ./scripts/COPY setup.py .

COPY setup.py .COPY jac_syntax_highlighter.py .

COPY jac_syntax_highlighter.py .COPY mkdocs.yml .

COPY mkdocs.yml .COPY README.md .

COPY README.md .

# Install dependencies

# Install Python dependenciesRUN pip install --no-cache-dir -e .

RUN pip install --no-cache-dir -e .

# Copy docs and scripts

# Expose port 8000COPY docs/ docs/

EXPOSE 8000COPY scripts/ scripts/



# Health check# Build the site

HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:8000/health || exit 1RUN mkdocs build



# Start the custom mkdocs server# Production stage

CMD ["python", "scripts/mkdocs_serve.py"]FROM nginx:alpine


# Copy built site from builder
COPY --from=builder /app/site /usr/share/nginx/html

# Copy nginx configuration for SPA routing
COPY <<EOF /etc/nginx/conf.d/default.conf
server {
    listen 80;
    server_name localhost;
    root /usr/share/nginx/html;
    index index.html;

    # Handle routing
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # Cache static assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
}
EOF

# Expose port 80
EXPOSE 80

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
