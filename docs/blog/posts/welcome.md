---
date: 2025-10-25
authors:
  - mars
categories:
  - Jac Programming
  - Tutorials
slug: welcome-to-jac-programming
---

# Welcome to Jac Programming!

This is your first blog post featuring interactive Jac code examples.

## What is Jac?

Jac is a modern programming language that combines the best of Python with powerful features for building scalable applications. It introduces Object-Spatial Programming (OSP), a new paradigm for thinking about data and computation.

<!-- more -->

## Try It Out!

Here's a simple "Hello World" program in Jac:

<div class="code-block">
```jac
with entry {
    print("Hello, World!");
}
```
</div>

## A More Complex Example

Let's create a simple calculator:

<div class="code-block">
```jac
can add(a: int, b: int) -> int {
    return a + b;
}

can multiply(a: int, b: int) -> int {
    return a * b;
}

with entry {
    x = 10;
    y = 5;

    print(f"{x} + {y} = {add(x, y)}");
    print(f"{x} * {y} = {multiply(x, y)}");

    # List comprehension
    squares = [i ** 2 for i in range(1, 6)];
    print(f"Squares: {squares}");
}
```
</div>

## Object-Oriented Jac

Jac supports powerful OOP features:

<div class="code-block">
```jac
obj Person {
    has name: str;
    has age: int;

    can init(name: str, age: int) {
        self.name = name;
        self.age = age;
    }

    can greet() {
        print(f"Hello, I'm {self.name} and I'm {self.age} years old!");
    }

    can birthday() {
        self.age += 1;
        print(f"Happy birthday! Now {self.age} years old.");
    }
}

with entry {
    person = Person("Alice", 25);
    person.greet();
    person.birthday();
    person.greet();
}
```
</div>

## What's Next?

Stay tuned for more posts about:

- Data structures in Jac
- Object-Spatial Programming concepts
- Building web applications with Jac
- AI integration with Jac

Happy coding!
