import torch.nn as nn


class Frozen(nn.Module):
    """A frozen part (20 parameters) and a trainable head (10 parameters)."""

    def __init__(self):
        super().__init__()
        self.fixed = nn.Linear(4, 4)
        for p in self.fixed.parameters():
            p.requires_grad = False
        self.head = nn.Linear(4, 2)

    def forward(self, x):
        return self.head(self.fixed(x))
