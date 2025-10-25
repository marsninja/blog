# Common Tasks - Jac Blog

Quick reference for common tasks when working with your Jac blog.

---

## Starting the Development Server

### Method 1: Custom Server (Recommended for runnable code)
```bash
cd ~/blog
python scripts/mkdocs_serve.py
```

This starts a server with CORS headers needed for interactive code execution.

### Method 2: Standard MkDocs (Syntax highlighting only)
```bash
cd ~/blog
mkdocs serve
```

Works for viewing the blog, but runnable code blocks may not work properly.

---

## Writing Blog Posts

### Create a New Post

1. **Create the file:**
   ```bash
   touch ~/blog/docs/posts/my-new-post.md
   ```

2. **Add content:** Use your favorite editor to write the post

3. **Add to navigation:**
   Edit `mkdocs.yml` and add your post:
   ```yaml
   nav:
     - Posts:
       - Welcome: posts/welcome.md
       - My New Post: posts/my-new-post.md  # Add this
   ```

4. **Preview:** The dev server will auto-reload!

---

## Adding Code Examples

### Static Syntax Highlighting

For code that just needs to look pretty:

````markdown
```jac
with entry {
    print("Hello, World!");
}
```
````

### Runnable Code Blocks

For interactive examples users can run:

````markdown
<div class="code-block">
```jac
with entry {
    print("Hello, World!");

    # Users can edit and run this!
    for i in range(5) {
        print(f"Count: {i}");
    }
}
```
</div>
````

### Code Block Options

**Default** - Shows "Run" button:
```markdown
<div class="code-block">
```

**Both buttons** - Shows "Run" and "Serve":
```markdown
<div class="code-block run-serve">
```

**Serve only** - Shows only "Serve" button:
```markdown
<div class="code-block serve-only">
```

---

## Customizing Your Blog

### Change Site Name and URL

Edit `mkdocs.yml`:
```yaml
site_name: My Awesome Blog
site_url: https://yourdomain.com
repo_url: https://github.com/yourusername/blog
```

### Change Colors

Edit `mkdocs.yml`:
```yaml
theme:
  palette:
    scheme: slate        # 'default' for light, 'slate' for dark
    primary: black       # Primary color
    accent: orange       # Accent color (Run button, links)
```

Available colors: red, pink, purple, deep purple, indigo, blue, light blue, cyan, teal, green, light green, lime, yellow, amber, orange, deep orange

### Change Fonts

Edit `mkdocs.yml`:
```yaml
theme:
  font:
    text: Roboto        # Body text font
    code: Roboto Mono   # Code font
```

### Add Social Links

Edit `mkdocs.yml`:
```yaml
extra:
  social:
    - icon: fontawesome/brands/github
      link: https://github.com/yourusername
    - icon: fontawesome/brands/twitter
      link: https://twitter.com/yourusername
    - icon: fontawesome/brands/linkedin
      link: https://linkedin.com/in/yourusername
```

### Custom CSS

Add your styles to `docs/extra.css`:

```css
/* Example: Change code block background */
.code-block {
    background-color: #1a1a1a !important;
}

/* Example: Change run button color */
.run-code-btn {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%) !important;
}
```

---

## Building and Deploying

### Build for Production

```bash
cd ~/blog
mkdocs build
```

This creates the `site/` directory with your static files.

### Deploy to GitHub Pages

1. **First time setup:**
   ```bash
   # Create a GitHub repository for your blog
   # Update repo_url in mkdocs.yml
   ```

2. **Deploy:**
   ```bash
   mkdocs gh-deploy
   ```

This builds the site and pushes to the `gh-pages` branch.

### Deploy to Netlify/Vercel

1. **Build command:** `mkdocs build`
2. **Publish directory:** `site`
3. **Python version:** 3.12

### Deploy to Your Own Server

```bash
# Build the site
mkdocs build

# Copy site/ directory to your server
scp -r site/* user@yourserver:/var/www/blog/
```

---

## Adding Features

### Add a New Page

1. **Create the markdown file:**
   ```bash
   touch ~/blog/docs/projects.md
   ```

2. **Add to navigation:**
   ```yaml
   nav:
     - Home: index.md
     - Posts: ...
     - Projects: projects.md  # Add this
     - About: about.md
   ```

### Add Tags to Posts

Install the blog plugin:
```bash
pip install mkdocs-material[blog]
```

Then configure in `mkdocs.yml`:
```yaml
plugins:
  - blog:
      blog_dir: posts
```

### Add Search

Already included! The search plugin is enabled by default.

### Add Comments

Use a service like:
- **Giscus** (GitHub Discussions)
- **Utterances** (GitHub Issues)
- **Disqus**

Add their embed code to a custom override template.

---

## Working with Images

### Add an Image to a Post

1. **Add image file:**
   ```bash
   cp my-image.png ~/blog/docs/assets/
   ```

2. **Reference in markdown:**
   ```markdown
   ![Description](../assets/my-image.png)
   ```

### Optimize Images

Before adding large images:
```bash
# Install imagemagick or similar
convert large-image.jpg -resize 1200x1200\> optimized-image.jpg
```

---

## Troubleshooting

### Code Blocks Not Running

**Problem:** Click "Run" but nothing happens

**Solutions:**
1. Use the custom server: `python scripts/mkdocs_serve.py`
2. Check browser console for errors (F12)
3. Ensure jaclang.zip exists: `ls docs/playground/jaclang.zip`
4. Verify CORS headers in Network tab

### Syntax Highlighting Not Working

**Problem:** Code appears without colors

**Solutions:**
1. Verify lexer is installed: `pip install -e .`
2. Check you're using `jac` as the language:
   ````markdown
   ```jac
   # not ```python or other
   ````
3. Rebuild: `mkdocs build --clean`

### Build Hook Errors

**Problem:** "jaclang package not found"

**Solutions:**
1. Install jaclang: `pip install jaclang`
2. Or temporarily remove hook from `mkdocs.yml`:
   ```yaml
   # hooks:
   #   - scripts/handle_jac_compile_data.py
   ```

### Changes Not Showing

**Problem:** Made changes but don't see them

**Solutions:**
1. Hard refresh browser: Ctrl+Shift+R (Cmd+Shift+R on Mac)
2. Clear browser cache
3. Restart dev server
4. Clean build: `mkdocs build --clean`

---

## Development Tips

### Live Reload Not Working?

The development server watches for file changes. If it's not reloading:
```bash
# Stop the server (Ctrl+C)
# Start it again
python scripts/mkdocs_serve.py
```

### Testing Locally

Always test both:
1. **Dev server:** Quick preview with hot reload
2. **Built site:** Final check before deployment
   ```bash
   mkdocs build
   cd site && python -m http.server 8080
   ```

### Version Control

**Files to commit:**
- All markdown files
- Configuration files
- Custom CSS/JS
- Assets (images, etc.)

**Files to ignore:** (already in .gitignore)
- `site/` directory
- `docs/playground/jaclang.zip`
- `__pycache__/`
- `.cache/`

---

## Getting Help

### Documentation
- [MkDocs Material](https://squidfunk.github.io/mkdocs-material/)
- [MkDocs](https://www.mkdocs.org/)
- [PyMdown Extensions](https://facelessuser.github.io/pymdown-extensions/)
- [Jac Language](https://jac-lang.org/)

### Blog Files
- `README.md` - Comprehensive setup guide
- `QUICKSTART.md` - Get started in 5 minutes
- `SETUP_COMPLETE.md` - What's included in this setup
- `TEST_RESULTS.md` - Verification that everything works

### Example Files
- `docs/index.md` - Homepage with runnable example
- `docs/posts/welcome.md` - Full post with multiple examples
- `mkdocs.yml` - Fully configured and commented

---

## Useful Commands Cheat Sheet

```bash
# Development
python scripts/mkdocs_serve.py      # Start dev server with CORS
mkdocs serve                         # Start standard dev server
mkdocs serve -a 0.0.0.0:8080        # Custom host/port

# Building
mkdocs build                         # Build production site
mkdocs build --clean                 # Clean build
mkdocs build --strict                # Fail on warnings

# Deployment
mkdocs gh-deploy                     # Deploy to GitHub Pages
mkdocs gh-deploy --force             # Force deploy

# Maintenance
pip install -U mkdocs-material       # Update Material theme
pip install -U -r requirements.txt   # Update all dependencies
mkdocs --version                     # Check MkDocs version
```

---

Happy blogging! 🚀
