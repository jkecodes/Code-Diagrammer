import torch
import torch.nn as nn
import torch.nn.functional as F


class Block(nn.Module):
    def __init__(self, ch):
        super().__init__()
        self.conv = nn.Conv2d(ch, ch, 3, padding=1)
        self.bn = nn.BatchNorm2d(ch)

    def forward(self, x):
        return F.relu(self.bn(self.conv(x))) + x


class SimpleCNN(nn.Module):
    def __init__(self, n_blocks=2):
        super().__init__()
        self.stem = nn.Sequential(nn.Conv2d(3, 8, 1), nn.ReLU())
        self.blocks = nn.Sequential(*[Block(8) for _ in range(n_blocks)])
        self.fc = nn.Linear(8, 10)

    def pool(self, x):
        return x.mean(dim=(2, 3))

    def forward(self, x, flag=False):
        x = self.stem(x)
        x = self.blocks(x)
        if flag:
            x = x * 2
        v = self.pool(x)
        v = v.view(v.shape[0], -1)
        return self.fc(v)
