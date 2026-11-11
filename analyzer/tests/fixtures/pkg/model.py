import torch.nn as nn

from .layers import Scale


class Wrapper(nn.Module):
    def __init__(self):
        super().__init__()
        self.scale = Scale()
        self.lin = nn.Linear(4, 4)

    def forward(self, x):
        return self.lin(self.scale(x))
