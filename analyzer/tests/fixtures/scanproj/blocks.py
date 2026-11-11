import torch.nn as nn


class Block(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc = nn.Linear(4, 4)

    def forward(self, x):
        return self.fc(x)


class Unused(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc = nn.Linear(4, 4)
