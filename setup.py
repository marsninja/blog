from setuptools import setup, find_packages

setup(
    name='jac-blog-syntax',
    version='1.0.0',
    description='Jac syntax highlighter for blog',
    py_modules=['jac_syntax_highlighter'],
    install_requires=[
        'Pygments>=2.0',
    ],
    entry_points={
        'pygments.lexers': [
            'jac = jac_syntax_highlighter:JacLexer',
        ],
    },
    classifiers=[
        'Development Status :: 4 - Beta',
        'Intended Audience :: Developers',
        'License :: OSI Approved :: MIT License',
        'Programming Language :: Python :: 3',
        'Topic :: Text Processing :: Linguistic',
    ],
)
