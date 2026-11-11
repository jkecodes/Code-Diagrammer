import torch.nn as nn


class LoopNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.layers = nn.ModuleList([nn.Linear(4, 4) for _ in range(3)])

    def forward(self, x):
        for layer in self.layers:
            x = layer(x)
        return x
