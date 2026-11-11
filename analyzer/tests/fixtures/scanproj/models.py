import torch.nn as nn

from blocks import Block


class Net(nn.Module):
    """A tiny net.

    More text.
    """

    def __init__(self):
        super().__init__()
        self.block = Block()
        self.fc = nn.Linear(4, 2)

    def forward(self, x, mask=None):
        return self.fc(self.block(x))
