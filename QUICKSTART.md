# Quick Start Guide

Get your Jac blog up and running in 5 minutes!

## 1. Install Dependencies

```bash
cd ~/blog
pip install -r requirements.txt
pip install -e .
```

## 2. Start the Development Server

```bash
python scripts/mkdocs_serve.py
```

Visit `http://127.0.0.1:8000` in your browser!

## 3. Write Your First Post

Create a new file `docs/posts/my-first-post.md`:

````markdown
# My First Post

This is my first blog post with Jac!

<div class="code-block">
```jac
with entry {
    print("Hello from my blog!");
}
```
</div>
````

## 4. Add It to Navigation

Edit `mkdocs.yml` and add your post:

```yaml
nav:
  - Posts:
    - Welcome: posts/welcome.md
    - My First Post: posts/my-first-post.md  # Add this line
```

## 5. See Your Changes

The development server will automatically reload with your changes!

## Next Steps

- Read the full [README.md](README.md) for more details
- Customize the theme in `mkdocs.yml`
- Add your own styles in `docs/extra.css`
- Deploy to GitHub Pages: `mkdocs gh-deploy`

Happy blogging!
