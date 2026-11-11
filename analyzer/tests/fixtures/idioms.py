"""Common PyTorch idioms found by the final review (each class reproduces one finding)."""
import torch
import torch.nn as nn
import torch.nn.functional


def swish(x):
    return x * torch.sigmoid(x)


class HelperFn(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc = nn.Linear(4, 4)
        self.head = nn.Linear(4, 2)

    def forward(self, x):
        x = self.fc(x)
        x = swish(x)
        return self.head(x)


class QualifiedFn(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc = nn.Linear(4, 4)
        self.head = nn.Linear(4, 2)

    def forward(self, x):
        x = self.fc(x)
        x = nn.functional.relu(x)
        return self.head(x)


class IndexedBlocks(nn.Module):
    def __init__(self):
        super().__init__()
        self.blocks = nn.ModuleList([nn.Linear(4, 4) for _ in range(2)])
        self.head = nn.Linear(4, 2)

    def forward(self, x):
        for i in range(2):
            x = self.blocks[i](x)
        return self.head(x)


class DictReturn(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc = nn.Linear(4, 2)

    def forward(self, x):
        return {"out": self.fc(x)}


class CondModule(nn.Module):
    def __init__(self, use_bn=True):
        super().__init__()
        self.norm = nn.BatchNorm1d(4) if use_bn else nn.Identity()
        self.fc = nn.Linear(4, 2)

    def forward(self, x):
        x = self.norm(x)
        return self.fc(x)


class Embedder(nn.Module):
    def __init__(self):
        super().__init__()
        self.enc = nn.Linear(4, 4)

    def embed(self, x):
        return self.enc(x)

    def forward(self, a, p, n):
        return self.embed(a), self.embed(p), self.embed(n)


class Mixer(nn.Module):
    def mix(self, a, scale, b):
        return b.mean(dim=1) * scale

    def forward(self, x, y):
        return self.mix(x, 3, y)


class Reused(nn.Module):
    def __init__(self):
        super().__init__()
        self.act = nn.Sequential(nn.ReLU(), nn.Dropout(0.1))

    def forward(self, a, b):
        return self.act(a), self.act(b)


class MultiLine(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc = nn.Linear(4, 4)
        self.head = nn.Linear(2, 2)

    def forward(self, x):
        x = self.fc(x)
        x = (x
             .view(2, 2, 2)
             .mean(1))
        return self.head(x)
